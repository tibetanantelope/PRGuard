import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { AnthropicModelAdapter } from '../anthropic-adapter.js'
import { runAgentTurn } from '../agent-loop.js'
import type { RuntimeConfig } from '../config.js'
import type { ModelAdapter } from '../types.js'
import { createDefaultToolRegistry } from '../tools/index.js'
import { parseUnifiedDiff, runGitCommand } from './repository.js'
import { withTraceModel, type PrGuardTrace } from './trace.js'
import { patchSchema, type Patch, type PrDiffSnapshot, type ReviewResult } from './types.js'
import { buildPatchSystemPrompt, buildPatchUserPrompt } from './repair-prompt.js'

const execFileAsync = promisify(execFile)

const modelPatchSchema = z.object({
  summary: z.string().min(1),
  unifiedDiff: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  findingIds: z.array(z.string().min(1)).min(1),
})

export type PatchApplicationResult = {
  patch: Patch
  verification: {
    status: 'passed' | 'failed'
    command: string
    output: string
  }
}

function extractJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? content.trim()
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) {
      throw new Error('PRGuard patch response did not contain a JSON object.')
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown
    } catch (error) {
      throw new Error(
        `PRGuard patch response contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export function parseModelPatchOutput(content: string, findingIds: string[]): Patch {
  const parsed = modelPatchSchema.safeParse(extractJsonObject(content))
  if (!parsed.success) {
    throw new Error(`Invalid PRGuard patch output: ${parsed.error.message}`)
  }
  const requested = new Set(findingIds)
  const returned = parsed.data.findingIds.filter(id => requested.has(id))
  if (returned.length !== requested.size) {
    throw new Error('PRGuard patch output does not cover every selected finding.')
  }
  return patchSchema.parse({
    ...parsed.data,
    findingIds: returned,
    status: 'pending',
  })
}

export async function generatePatch(
  snapshot: PrDiffSnapshot,
  review: ReviewResult,
  findingIds: string[],
  runtime: RuntimeConfig,
  options: { model?: ModelAdapter; maxSteps?: number; trace?: PrGuardTrace } = {},
): Promise<Patch> {
  const selected = review.findings.filter(finding => findingIds.includes(finding.id))
  if (selected.length !== findingIds.length) {
    throw new Error('One or more requested Finding IDs were not found.')
  }

  const allTools = await createDefaultToolRegistry({
    cwd: snapshot.input.cwd,
    runtime,
  })
  const readOnlyTools = allTools.subset([
    'list_files',
    'grep_files',
    'read_file',
    'load_skill',
  ])
  const baseModel = options.model ?? new AnthropicModelAdapter(
    readOnlyTools,
    async () => runtime,
  )
  const model = options.trace ? withTraceModel(baseModel, options.trace) : baseModel
  const messages = await runAgentTurn({
    model,
    tools: readOnlyTools,
    cwd: snapshot.input.cwd,
    maxSteps: options.maxSteps ?? 12,
    modelName: runtime.model,
    onToolStart: (toolName, input) => {
      void options.trace?.record('tool_started', {
        toolName,
        inputKeys: typeof input === 'object' && input !== null ? Object.keys(input) : [],
      })
    },
    onToolResult: (toolName, output, isError) => {
      void options.trace?.record('tool_finished', {
        toolName,
        ok: !isError,
        outputChars: output.length,
      })
    },
    messages: [
      { role: 'system', content: buildPatchSystemPrompt() },
      { role: 'user', content: buildPatchUserPrompt(snapshot, review, findingIds) },
    ],
  })
  const finalMessage = [...messages]
    .reverse()
    .find(message => message.role === 'assistant')
  if (!finalMessage || finalMessage.role !== 'assistant') {
    throw new Error('PRGuard patch generation did not produce a final response.')
  }
  const patch = parseModelPatchOutput(finalMessage.content, findingIds)
  await options.trace?.record('patch_generated', {
    findingIds: patch.findingIds,
    files: patch.files,
    patchChars: patch.unifiedDiff.length,
  })
  return patch
}

function validatePatchPaths(patchText: string): void {
  const files = parseUnifiedDiff(patchText)
  if (files.length === 0) {
    throw new Error('Generated patch contains no Git file changes.')
  }
  for (const file of files) {
    for (const filePath of [file.path, file.oldPath]) {
      if (!filePath) continue
      if (
        filePath.startsWith('/') ||
        filePath.startsWith('\\') ||
        filePath.split(/[\\/]+/).includes('..')
      ) {
        throw new Error(`Generated patch contains an unsafe path: ${filePath}`)
      }
    }
  }
}

function runGitWithPatch(
  cwd: string,
  args: string[],
  patchText: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ stdout, stderr, code: code ?? 1 }))
    child.stdin.end(patchText)
  })
}

async function ensureCleanWorktree(cwd: string): Promise<void> {
  const result = await runGitCommand(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])
  if (result.stdout.trim()) {
    throw new Error('Refusing to apply Patch: the worktree has tracked local changes.')
  }
}

async function applyPatchText(cwd: string, patchText: string): Promise<void> {
  const result = await runGitWithPatch(
    cwd,
    ['apply', '--check', '--whitespace=error', '-'],
    patchText,
  )
  if (result.code !== 0) {
    throw new Error(`Patch check failed: ${result.stderr || result.stdout}`.trim())
  }
  const applied = await runGitWithPatch(
    cwd,
    ['apply', '--whitespace=error', '-'],
    patchText,
  )
  if (applied.code !== 0) {
    throw new Error(`Patch apply failed: ${applied.stderr || applied.stdout}`.trim())
  }
}

function splitCommand(commandLine: string): [string, string[]] {
  const parts = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(part =>
    part.replace(/^(["'])(.*)\1$/, '$2'),
  ) ?? []
  const [command, ...args] = parts
  if (!command) throw new Error('Verification command cannot be empty.')
  return [command, args]
}

export async function runVerificationCommand(
  cwd: string,
  commandLine: string,
): Promise<{ passed: boolean; output: string }> {
  const [command, args] = splitCommand(commandLine)
  const allowedCommands = new Set([
    'npm',
    'npm.cmd',
    'pnpm',
    'pnpm.cmd',
    'yarn',
    'yarn.cmd',
    'node',
    'node.exe',
    'pytest',
    'cargo',
    'go',
  ])
  if (!allowedCommands.has(command.toLowerCase())) {
    throw new Error(`Verification command is not allowed: ${command}`)
  }
  try {
    const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    const executable = isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : command
    const executableArgs = isWindowsScript
      ? ['/d', '/s', '/c', [command, ...args].join(' ')]
      : args
    const result = await execFileAsync(executable, executableArgs, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    return {
      passed: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string }
    return {
      passed: false,
      output: [detail.stdout, detail.stderr, detail.message].filter(Boolean).join('\n').trim(),
    }
  }
}

export async function applyAndVerifyPatch(
  cwd: string,
  patch: Patch,
  testCommand: string,
  options: { trace?: PrGuardTrace } = {},
): Promise<PatchApplicationResult> {
  validatePatchPaths(patch.unifiedDiff)
  await ensureCleanWorktree(cwd)
  await applyPatchText(cwd, patch.unifiedDiff)
  await options.trace?.record('patch_applied', {
    findingIds: patch.findingIds,
    files: patch.files,
  })

  const verification = await runVerificationCommand(cwd, testCommand)
  await options.trace?.record('verification', {
    status: verification.passed ? 'passed' : 'failed',
    command: testCommand,
    outputChars: verification.output.length,
  })

  if (verification.passed) {
    return {
      patch: patchSchema.parse({ ...patch, status: 'applied' }),
      verification: { status: 'passed', command: testCommand, output: verification.output },
    }
  }

  const reverted = await runGitWithPatch(cwd, ['apply', '-R', '-'], patch.unifiedDiff)
  if (reverted.code !== 0) {
    throw new Error(`Verification failed and automatic rollback failed: ${reverted.stderr || reverted.stdout}`.trim())
  }
  await options.trace?.record('rollback', {
    status: 'completed',
    reason: 'verification_failed',
  })
  return {
    patch: patchSchema.parse({ ...patch, status: 'rolled_back' }),
    verification: { status: 'failed', command: testCommand, output: verification.output },
  }
}

export function formatPatch(patch: Patch): string {
  return [
    `Patch: ${patch.summary}`,
    `Files: ${patch.files.join(', ')}`,
    `Findings: ${patch.findingIds.join(', ')}`,
    '',
    patch.unifiedDiff,
  ].join('\n')
}
