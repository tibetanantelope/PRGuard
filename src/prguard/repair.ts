import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
import {
  runSandboxedVerification,
  type VerificationProcessExecutor,
  type VerificationSandboxConfig,
} from './sandbox.js'

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
    timedOut?: boolean
    isolation: 'local-process' | 'docker-container'
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
  const toolStartedAt = new Map<string, number>()
  const messages = await runAgentTurn({
    model,
    tools: readOnlyTools,
    cwd: snapshot.input.cwd,
    maxSteps: options.maxSteps ?? 12,
    modelName: runtime.model,
    onToolStart: (toolName, input) => {
      toolStartedAt.set(toolName, performance.now())
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
        durationMs: Math.round(performance.now() - (toolStartedAt.get(toolName) ?? performance.now())),
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

export function validatePatchSafety(
  patchText: string,
  limits: { maxBytes?: number; maxFiles?: number } = {},
): void {
  const maxBytes = limits.maxBytes ?? 1024 * 1024
  const maxFiles = limits.maxFiles ?? 100
  if (Buffer.byteLength(patchText, 'utf8') > maxBytes) {
    throw new Error(`Generated patch exceeds the ${maxBytes} byte safety limit.`)
  }
  if (/^GIT binary patch$|^Binary files /m.test(patchText)) {
    throw new Error('Generated patch contains binary content, which is not allowed.')
  }
  if (/^(?:new file mode|old mode) (?:120000|160000)$/m.test(patchText)) {
    throw new Error('Generated patch cannot create symlinks or Git submodules.')
  }
  const files = parseUnifiedDiff(patchText)
  if (files.length === 0) {
    throw new Error('Generated patch contains no Git file changes.')
  }
  if (files.length > maxFiles) {
    throw new Error(`Generated patch exceeds the ${maxFiles} file safety limit.`)
  }
  for (const file of files) {
    for (const filePath of [file.path, file.oldPath]) {
      if (!filePath) continue
      const segments = filePath.split(/[\\/]+/)
      if (
        filePath.startsWith('/') ||
        filePath.startsWith('\\') ||
        segments.includes('..') ||
        segments.some(segment => segment.toLowerCase() === '.git')
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

export async function runVerificationCommand(
  cwd: string,
  commandLine: string,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    sandbox?: Partial<VerificationSandboxConfig>
    executor?: VerificationProcessExecutor
  } = {},
): Promise<{ passed: boolean; output: string; timedOut?: boolean; isolation: 'local-process' | 'docker-container' }> {
  return runSandboxedVerification(cwd, commandLine, options)
}

async function createVerificationWorktree(cwd: string): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'prguard-worktree-'))
  const worktree = path.join(parent, 'repo')
  try {
    const result = await runGitCommand(cwd, ['worktree', 'add', '--detach', worktree, 'HEAD'])
    if (result.stderr.trim()) {
      // Git may report normal progress on stderr; only the exit code is authoritative.
    }
    return worktree
  } catch (error) {
    await rm(parent, { recursive: true, force: true })
    throw error
  }
}

async function removeVerificationWorktree(cwd: string, worktree: string): Promise<void> {
  await runGitCommand(cwd, ['worktree', 'remove', '--force', worktree]).catch(() => undefined)
  await rm(path.dirname(worktree), { recursive: true, force: true })
}

export async function applyAndVerifyPatch(
  cwd: string,
  patch: Patch,
  testCommand: string,
  options: {
    trace?: PrGuardTrace
    verificationTimeoutMs?: number
    signal?: AbortSignal
    sandbox?: Partial<VerificationSandboxConfig>
    verificationExecutor?: VerificationProcessExecutor
    patchLimits?: { maxBytes?: number; maxFiles?: number }
  } = {},
): Promise<PatchApplicationResult> {
  validatePatchSafety(patch.unifiedDiff, options.patchLimits)
  await ensureCleanWorktree(cwd)
  const worktree = await createVerificationWorktree(cwd)
  await options.trace?.record('checkpoint', {
    phase: 'repair_verification_workspace_created',
    isolated: true,
  })
  try {
    await applyPatchText(worktree, patch.unifiedDiff)
    const verification = await runVerificationCommand(worktree, testCommand, {
      timeoutMs: options.verificationTimeoutMs,
      signal: options.signal,
      sandbox: options.sandbox,
      executor: options.verificationExecutor,
    })
    await options.trace?.record('verification', {
      status: verification.passed ? 'passed' : 'failed',
      command: testCommand,
      outputChars: verification.output.length,
      isolated: true,
      processIsolation: verification.isolation,
      timedOut: verification.timedOut === true,
    })

    if (!verification.passed) {
      await options.trace?.record('rollback', {
        status: 'completed',
        reason: verification.timedOut ? 'verification_timed_out' : 'verification_failed',
        isolated: true,
      })
      return {
        patch: patchSchema.parse({ ...patch, status: 'rolled_back' }),
        verification: { status: 'failed', command: testCommand, output: verification.output, timedOut: verification.timedOut, isolation: verification.isolation },
      }
    }

    // Re-check before changing the user's worktree. A concurrent edit must never be overwritten.
    await ensureCleanWorktree(cwd)
    await applyPatchText(cwd, patch.unifiedDiff)
    await options.trace?.record('patch_applied', {
      findingIds: patch.findingIds,
      files: patch.files,
      verificationWorkspace: 'isolated',
    })
    return {
      patch: patchSchema.parse({ ...patch, status: 'applied' }),
      verification: { status: 'passed', command: testCommand, output: verification.output, isolation: verification.isolation },
    }
  } finally {
    await removeVerificationWorktree(cwd, worktree)
    await options.trace?.record('checkpoint', {
      phase: 'repair_verification_workspace_removed',
      isolated: true,
    })
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
