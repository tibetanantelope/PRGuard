import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPrGuardServer } from '../src/prguard/http.js'
import type { RuntimeConfig } from '../src/config.js'
import { FileReviewJobRepository } from '../src/prguard/job-repository.js'
import type { ReviewJob } from '../src/prguard/jobs.js'

const runtime: RuntimeConfig = {
  model: 'test-model',
  baseUrl: 'http://localhost',
  mcpServers: {},
  sourceSummary: 'test',
}

async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port')
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

describe('PRGuard HTTP API', () => {
  it('exposes health and trace endpoints', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-http-'))
    const previousHome = process.env.MINI_CODE_HOME
    const server = createPrGuardServer({ runtime, traceBaseDir: baseDir })
    const listener = await listen(server)
    try {
      const health = await fetch(`http://127.0.0.1:${listener.port}/healthz`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { status: 'ok', service: 'prguard' })

      const traces = await fetch(`http://127.0.0.1:${listener.port}/api/v1/traces`)
      assert.equal(traces.status, 200)
      assert.deepEqual(await traces.json(), { traces: [] })
    } finally {
      await listener.close()
      if (previousHome === undefined) delete process.env.MINI_CODE_HOME
      else process.env.MINI_CODE_HOME = previousHome
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('rejects malformed review requests with a client error', async () => {
    const server = createPrGuardServer({ runtime })
    const listener = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/api/v1/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'D:/missing' }),
      })
      assert.equal(response.status, 400)
      const body = await response.json() as { error: string }
      assert.match(body.error, /Invalid PR review input/)
    } finally {
      await listener.close()
    }
  })

  it('rejects malformed async review jobs with a client error', async () => {
    const server = createPrGuardServer({ runtime })
    const listener = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'D:/missing' }),
      })
      assert.equal(response.status, 400)
      const body = await response.json() as { error: string }
      assert.match(body.error, /Invalid PR review input/)
    } finally {
      await listener.close()
    }
  })

  it('requires explicit approval inputs for repair requests', async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-repair-api-'))
    const job: ReviewJob = {
      jobId: 'completed-repair-job',
      status: 'completed',
      multiAgent: true,
      input: { cwd: process.cwd(), diffText: 'diff --git a/a b/a\n' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: process.cwd(),
      attempts: 1,
      maxAttempts: 3,
      result: {
        schemaVersion: '0.1',
        reviewId: 'review-1',
        createdAt: new Date().toISOString(),
        input: { cwd: process.cwd(), diffText: 'diff --git a/a b/a\n' },
        findings: [],
        summary: {
          totalFindings: 0,
          bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
          byCategory: { security: 0, reliability: 0, code_quality: 0 },
        },
      },
    }
    const repository = new FileReviewJobRepository(jobDir)
    await repository.create(job)
    const server = createPrGuardServer({ runtime, jobRepository: repository })
    const listener = await listen(server)
    try {
      const missingFindings = await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs/${job.jobId}/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply: false }),
      })
      assert.equal(missingFindings.status, 400)
      assert.match((await missingFindings.json() as { error: string }).error, /findingIds/)

      const missingTest = await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs/${job.jobId}/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ findingIds: ['finding-1'], apply: true }),
      })
      assert.equal(missingTest.status, 400)
      assert.match((await missingTest.json() as { error: string }).error, /testCommand/)
    } finally {
      await listener.close()
      await rm(jobDir, { recursive: true, force: true })
    }
  })
})
