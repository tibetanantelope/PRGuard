import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGithubPrDiff, parseGithubPrRef } from '../src/prguard/index.js'

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
})
