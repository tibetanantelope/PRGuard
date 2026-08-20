import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { discoverInstructionFiles } from '../memory.js'
import {
  reviewInputSchema,
  type ChangedFile,
  type DiffHunk,
  type DiffStatus,
  type PrDiffSnapshot,
  type RepositoryContext,
  type ReviewInput,
} from './types.js'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 8 * 1024 * 1024

type GitResult = {
  stdout: string
  stderr: string
}

export async function runGitCommand(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_DIFF_BYTES,
      windowsHide: true,
    })
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed: ${message}`)
  }
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseHunkHeader(line: string): DiffHunk | null {
  const match = line.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
  )
  if (!match) return null
  return {
    oldStart: Number(match[1]),
    oldCount: parsePositiveNumber(match[2], 1),
    newStart: Number(match[3]),
    newCount: parsePositiveNumber(match[4], 1),
    header: line,
  }
}

function normalizeDiffPath(value: string): string {
  return value.replace(/^a\//, '').replace(/^b\//, '')
}

function parseDiffHeader(line: string): { oldPath: string; path: string } | null {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
  if (!match) return null
  return {
    oldPath: normalizeDiffPath(match[1]),
    path: normalizeDiffPath(match[2]),
  }
}

function detectStatus(lines: string[], oldPath: string, filePath: string): DiffStatus {
  if (lines.some(line => line.startsWith('new file mode '))) return 'added'
  if (lines.some(line => line.startsWith('deleted file mode '))) return 'deleted'
  if (lines.some(line => line.startsWith('similarity index '))) {
    return oldPath === filePath ? 'modified' : 'renamed'
  }
  if (lines.some(line => line.startsWith('copy from '))) return 'copied'
  return 'modified'
}

export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  const lines = diffText.replace(/^\uFEFF/, '').split(/\r?\n/)
  const files: ChangedFile[] = []
  let current: {
    oldPath: string
    path: string
    lines: string[]
    hunks: DiffHunk[]
  } | null = null

  const flush = (): void => {
    if (!current) return
    let additions = 0
    let deletions = 0
    for (const line of current.lines) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) additions += 1
      if (line.startsWith('-')) deletions += 1
    }
    const changedFile: ChangedFile = {
      path: current.path,
      status: detectStatus(current.lines, current.oldPath, current.path),
      additions,
      deletions,
      hunks: current.hunks,
    }
    if (current.oldPath !== current.path) {
      changedFile.oldPath = current.oldPath
    }
    files.push(changedFile)
  }

  for (const line of lines) {
    const header = parseDiffHeader(line)
    if (header) {
      flush()
      current = { ...header, lines: [], hunks: [] }
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const hunk = parseHunkHeader(line)
    if (hunk) current.hunks.push(hunk)
  }
  flush()
  return files
}

function resolveDiffPath(cwd: string, diffPath: string): string {
  const root = path.resolve(cwd)
  const resolved = path.resolve(root, diffPath)
  const relative = path.relative(root, resolved)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Diff path escapes workspace: ${diffPath}`)
  }
  return resolved
}

async function loadDiff(input: ReviewInput): Promise<string> {
  if (input.diffText) return input.diffText
  if (input.diffPath) {
    const filePath = resolveDiffPath(input.cwd, input.diffPath)
    return readFile(filePath, 'utf8')
  }

  const args = ['diff', '--no-ext-diff', '--unified=3', input.baseRef!]
  if (input.headRef) args.push(input.headRef)
  args.push('--')
  const result = await runGitCommand(input.cwd, args)
  return result.stdout
}

async function findExistingProjectFiles(root: string): Promise<string[]> {
  const candidates = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'Makefile',
  ]
  const existing: string[] = []
  for (const candidate of candidates) {
    try {
      await access(path.join(root, candidate))
      existing.push(candidate)
    } catch {
      // Ignore absent project manifests.
    }
  }
  return existing
}

export async function loadRepositoryContext(cwd: string): Promise<RepositoryContext> {
  const rootResult = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  const root = rootResult.stdout.trim()
  if (!root) throw new Error('Unable to determine the Git repository root.')

  const branchResult = await runGitCommand(cwd, ['branch', '--show-current'])
  const branch = branchResult.stdout.trim() || undefined
  const instructionFiles = (await discoverInstructionFiles(cwd)).map(file => file.path)

  return {
    root,
    branch,
    projectFiles: await findExistingProjectFiles(root),
    instructionFiles,
  }
}

export async function loadPrDiffSnapshot(rawInput: unknown): Promise<PrDiffSnapshot> {
  const parsed = reviewInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new Error(`Invalid PR review input: ${parsed.error.message}`)
  }

  const input = parsed.data
  const diffText = await loadDiff(input)
  if (Buffer.byteLength(diffText, 'utf8') > MAX_DIFF_BYTES) {
    throw new Error(`Diff is too large. Maximum supported size is ${MAX_DIFF_BYTES} bytes.`)
  }

  return {
    input,
    diffText,
    changedFiles: parseUnifiedDiff(diffText),
    repository: await loadRepositoryContext(input.cwd),
  }
}

export function formatDiffSnapshot(snapshot: PrDiffSnapshot): string {
  const { changedFiles, repository } = snapshot
  const fileLines = changedFiles.length === 0
    ? ['(no changed files)']
    : changedFiles.map(file => {
        const counts = `+${file.additions}/-${file.deletions}`
        const hunks = `${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'}`
        return `${file.status.padEnd(8)} ${file.path} (${counts}, ${hunks})`
      })

  return [
    `repository: ${repository.root}`,
    `branch: ${repository.branch ?? '(detached)'}`,
    `changed files: ${changedFiles.length}`,
    ...fileLines,
    `project files: ${repository.projectFiles.join(', ') || '(none detected)'}`,
    `instruction files: ${repository.instructionFiles.length}`,
  ].join('\n')
}
