import { loadPrDiffSnapshot, loadRepositoryContext, parseUnifiedDiff } from './repository.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import type { PrDiffSnapshot, ReviewInput } from './types.js'

const MAX_GITHUB_DIFF_BYTES = 8 * 1024 * 1024

export type GithubPrRef = { owner: string; repo: string; number: number }

export type GithubWebhookEvent = {
  action?: string
  pull_request?: { number?: number; base?: { ref?: string }; head?: { ref?: string } }
  repository?: { name?: string; owner?: { login?: string } }
}

export type GithubWebhookDeliveryStore = {
  claim(deliveryId: string): Promise<boolean>
}

export class FileGithubWebhookDeliveryStore implements GithubWebhookDeliveryStore {
  private readonly claimed = new Set<string>()
  private loaded: Promise<void> | undefined

  constructor(private readonly filePath = path.join(MINI_CODE_DIR, 'prguard', 'github-deliveries.json')) {}

  async claim(deliveryId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(deliveryId)) return false
    await this.load()
    if (this.claimed.has(deliveryId)) return false
    this.claimed.add(deliveryId)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify([...this.claimed].slice(-10_000), null, 2)}\n`, 'utf8')
    return true
  }

  private async load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = readFile(this.filePath, 'utf8')
        .then(content => {
          const values: unknown = JSON.parse(content)
          if (Array.isArray(values)) {
            for (const value of values) if (typeof value === 'string') this.claimed.add(value)
          }
        })
        .catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
    }
    await this.loaded
  }
}

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

export function verifyGithubWebhookSignature(body: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith('sha256=') || !secret) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const received = signature.slice('sha256='.length)
  if (!/^[a-f0-9]{64}$/i.test(received)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

export function parseGithubWebhookEvent(value: unknown): GithubPrRef | null {
  if (!value || typeof value !== 'object') return null
  const event = value as GithubWebhookEvent
  const owner = event.repository?.owner?.login
  const repo = event.repository?.name
  const pullNumber = event.pull_request?.number
  if (!owner || !repo || pullNumber === undefined || !Number.isSafeInteger(pullNumber) || pullNumber <= 0) return null
  return parseGithubPrRef(`${owner}/${repo}#${pullNumber}`)
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
  githubSha?: string
  fetchImpl?: typeof fetch
  token?: string
}): Promise<PrDiffSnapshot> {
  const fetched = await fetchGithubPrDiff(args.githubRef, { fetchImpl: args.fetchImpl, token: args.token })
  const input: ReviewInput = {
    cwd: args.cwd,
    githubRef: `${fetched.reference.owner}/${fetched.reference.repo}#${fetched.reference.number}`,
    githubSha: args.githubSha,
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

export async function publishGithubReviewFeedback(
  reference: string,
  headSha: string,
  result: { findings: Array<{ severity: string; title: string; file: string; lineStart: number }>; summary: { totalFindings: number } },
  options: { token: string; fetchImpl?: typeof fetch } ,
): Promise<void> {
  const parsed = parseGithubPrRef(reference)
  const fetchImpl = options.fetchImpl ?? fetch
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${options.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'PRGuard/0.1',
  }
  const checkResponse = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/check-runs`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'PRGuard Review',
        head_sha: headSha,
        status: 'completed',
        conclusion: result.summary.totalFindings === 0 ? 'success' : 'action_required',
        output: {
          title: result.summary.totalFindings === 0 ? 'No risks found' : `${result.summary.totalFindings} risk(s) found`,
          summary: result.findings.slice(0, 20).map(finding =>
            `- **${finding.severity.toUpperCase()}** ${finding.title} (${finding.file}:${finding.lineStart})`,
          ).join('\n') || 'PRGuard completed the review.',
        },
      }),
    },
  )
  if (!checkResponse.ok) throw new Error(`GitHub Check Run request failed with HTTP ${checkResponse.status}`)

  const commentResponse = await fetchImpl(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body: [
          '<!-- prguard-review -->',
          `## PRGuard Review: ${result.summary.totalFindings} finding(s)`,
          result.summary.totalFindings === 0
            ? 'No evidence-backed risks were found.'
            : result.findings.slice(0, 20).map(finding =>
              `- **${finding.severity.toUpperCase()}** ${finding.title} — \`${finding.file}:${finding.lineStart}\``,
            ).join('\n'),
        ].join('\n'),
      }),
    },
  )
  if (!commentResponse.ok) throw new Error(`GitHub PR comment request failed with HTTP ${commentResponse.status}`)
}
