import { loadPrDiffSnapshot, loadRepositoryContext, parseUnifiedDiff } from './repository.js'
import type { PrDiffSnapshot, ReviewInput } from './types.js'

const MAX_GITHUB_DIFF_BYTES = 8 * 1024 * 1024

export type GithubPrRef = { owner: string; repo: string; number: number }

function validatePart(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid GitHub ${label}: ${value}`)
  }
  return value
}

export function parseGithubPrRef(value: string): GithubPrRef {
  const input = value.trim()
  const urlMatch = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i)
  const shortMatch = input.match(/^([^/]+)\/([^/#]+)#(\d+)$/)
  const match = urlMatch ?? shortMatch
  if (!match) {
    throw new Error('GitHub PR must look like owner/repo#123 or https://github.com/owner/repo/pull/123')
  }
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid GitHub PR number: ${match[3]}`)
  return { owner: validatePart(match[1]!, 'owner'), repo: validatePart(match[2]!, 'repository'), number }
}

export async function fetchGithubPrDiff(
  reference: string,
  options: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<{ reference: GithubPrRef; diffText: string }> {
  const parsed = parseGithubPrRef(reference)
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const response = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
    {
      headers: {
        Accept: 'application/vnd.github.v3.diff',
        'User-Agent': 'PRGuard/0.1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  )
  if (!response.ok) throw new Error(`GitHub PR diff request failed with HTTP ${response.status}`)
  const diffText = await response.text()
  if (Buffer.byteLength(diffText, 'utf8') > MAX_GITHUB_DIFF_BYTES) {
    throw new Error(`GitHub PR diff is too large. Maximum supported size is ${MAX_GITHUB_DIFF_BYTES} bytes.`)
  }
  return { reference: parsed, diffText }
}

export async function loadGithubPrDiffSnapshot(args: {
  cwd: string
  githubRef: string
  testCommand?: string
  fetchImpl?: typeof fetch
  token?: string
}): Promise<PrDiffSnapshot> {
  const fetched = await fetchGithubPrDiff(args.githubRef, { fetchImpl: args.fetchImpl, token: args.token })
  const input: ReviewInput = {
    cwd: args.cwd,
    githubRef: `${fetched.reference.owner}/${fetched.reference.repo}#${fetched.reference.number}`,
    diffText: fetched.diffText,
    testCommand: args.testCommand,
  }
  const snapshot = await loadPrDiffSnapshot(input)
  return {
    ...snapshot,
    repository: await loadRepositoryContext(args.cwd),
    changedFiles: parseUnifiedDiff(fetched.diffText),
  }
}
