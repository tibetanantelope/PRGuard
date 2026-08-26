import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { fetchGithubPrDiff, FileGithubWebhookDeliveryStore, parseGithubPrRef, parseGithubWebhookEvent, publishGithubReviewFeedback, verifyGithubWebhookSignature } from '../src/prguard/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('PRGuard GitHub input', () => {
  it('parses short and URL pull request references', () => {
    assert.deepEqual(parseGithubPrRef('octo/demo#42'), {
      owner: 'octo',
      repo: 'demo',
      number: 42,
    })
    assert.deepEqual(parseGithubPrRef('https://github.com/octo/demo/pull/42/files'), {
      owner: 'octo',
      repo: 'demo',
      number: 42,
    })
    assert.throws(() => parseGithubPrRef('../secret#1'), /Invalid GitHub owner/)
  })

  it('fetches a diff with read-only GitHub headers and optional token', async () => {
    let requestedUrl = ''
    let requestedHeaders: Record<string, string> | undefined
    const result = await fetchGithubPrDiff('octo/demo#42', {
      token: 'test-token',
      fetchImpl: async (input, init) => {
        requestedUrl = String(input)
        requestedHeaders = init?.headers as Record<string, string>
        return new Response('diff --git a/README.md b/README.md\n', { status: 200 })
      },
    })

    assert.equal(result.reference.number, 42)
    assert.equal(result.diffText, 'diff --git a/README.md b/README.md\n')
    assert.equal(requestedUrl, 'https://api.github.com/repos/octo/demo/pulls/42')
    assert.equal(requestedHeaders?.Accept, 'application/vnd.github.v3.diff')
    assert.equal(requestedHeaders?.Authorization, 'Bearer test-token')
  })

  it('verifies webhook signatures and extracts pull request references', () => {
    const body = JSON.stringify({ action: 'synchronize' })
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    assert.equal(verifyGithubWebhookSignature(body, signature, 'secret'), true)
    assert.equal(verifyGithubWebhookSignature(body, `${signature}00`, 'secret'), false)
    assert.deepEqual(parseGithubWebhookEvent({
      repository: { name: 'demo', owner: { login: 'octo' } },
      pull_request: { number: 42 },
    }), { owner: 'octo', repo: 'demo', number: 42 })
    assert.equal(parseGithubWebhookEvent({ action: 'opened' }), null)
  })

  it('claims each GitHub webhook delivery only once and persists the claim', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-delivery-'))
    const filePath = path.join(dir, 'deliveries.json')
    try {
      const first = new FileGithubWebhookDeliveryStore(filePath)
      assert.equal(await first.claim('delivery-001'), true)
      assert.equal(await first.claim('delivery-001'), false)
      const second = new FileGithubWebhookDeliveryStore(filePath)
      assert.equal(await second.claim('delivery-001'), false)
      assert.match(await readFile(filePath, 'utf8'), /delivery-001/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('publishes a Check Run and a PR comment with structured findings', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    await publishGithubReviewFeedback('octo/demo#42', 'abcdef1234567', {
      findings: [{ severity: 'high', title: 'Command injection', file: 'src/run.ts', lineStart: 8 }],
      summary: { totalFindings: 1 },
    }, {
      token: 'test-token',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response('{}', { status: 201 })
      },
    })
    assert.equal(requests.length, 2)
    assert.match(requests[0]!.url, /check-runs$/)
    assert.equal(requests[0]!.body.head_sha, 'abcdef1234567')
    assert.match(requests[1]!.url, /issues\/42\/comments$/)
  })
})
