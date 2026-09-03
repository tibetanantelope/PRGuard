import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { RuntimeConfig } from '../src/config.js'
import { FileReviewJobRepository } from '../src/prguard/job-repository.js'
import { FileReviewJobOutbox, type ReviewJobOutbox } from '../src/prguard/job-outbox.js'
import { InMemoryReviewJobQueue } from '../src/prguard/queue.js'
import { ReviewJobService, retryDelayMs, type ReviewJob } from '../src/prguard/jobs.js'
import { NoopReviewPersistence } from '../src/prguard/review-persistence.js'

const runtime: RuntimeConfig = {
  model: 'test-model', baseUrl: 'http://localhost', apiKey: 'test', mcpServers: {}, sourceSummary: 'test',
}

function job(status: ReviewJob['status'] = 'queued'): ReviewJob {
  return {
    jobId: 'outbox-job-1', status, multiAgent: false, input: { cwd: 'D:/demo', diffText: 'diff' },
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', cwd: 'D:/demo',
    attempts: status === 'queued' ? 0 : 3, maxAttempts: 3, fencingToken: status === 'queued' ? 0 : 3,
    error: status === 'failed' ? 'model unavailable' : undefined,
  }
}

test('outbox scheduling is durable and deduplicated by idempotency key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-outbox-store-'))
  try {
    const outbox = new FileReviewJobOutbox(dir)
    const input = {
      jobId: 'job-1', kind: 'enqueue' as const, idempotencyKey: 'enqueue:job-1:0',
      availableAt: '2026-09-02T00:01:00.000Z', createdAt: '2026-09-02T00:00:00.000Z',
    }
    const first = await outbox.schedule(input)
    const duplicate = await outbox.schedule(input)
    assert.equal(duplicate.id, first.id)
    assert.equal((await outbox.due('2026-09-02T00:00:59.000Z')).length, 0)
    assert.equal((await outbox.due('2026-09-02T00:01:00.000Z')).length, 1)
    await outbox.markPublished(first.id, '2026-09-02T00:01:01.000Z')
    assert.equal((await outbox.due('2026-09-02T00:02:00.000Z')).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('queue reconciliation recovers a queued job when the process crashed before enqueue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-outbox-reconcile-'))
  try {
    const repository = new FileReviewJobRepository(path.join(dir, 'jobs'))
    const queue = new InMemoryReviewJobQueue()
    const outbox = new FileReviewJobOutbox(path.join(dir, 'outbox'))
    await repository.create(job())
    const service = new ReviewJobService(runtime, repository, undefined, queue, new NoopReviewPersistence(), outbox)
    assert.equal(await service.reconcileQueue('2026-09-02T00:01:00.000Z'), 1)
    assert.equal((await queue.consume())?.jobId, 'outbox-job-1')
    assert.equal(await service.reconcileQueue('2026-09-02T00:02:00.000Z'), 0)
    assert.equal(await queue.consume(), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('idempotent queue publication survives a crash after enqueue but before outbox acknowledgement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-outbox-crash-'))
  try {
    const repository = new FileReviewJobRepository(path.join(dir, 'jobs'))
    const queue = new InMemoryReviewJobQueue()
    const delegate = new FileReviewJobOutbox(path.join(dir, 'outbox'))
    let failOnce = true
    const outbox: ReviewJobOutbox = {
      schedule: input => delegate.schedule(input), due: (now, limit) => delegate.due(now, limit),
      markFailed: (id, error) => delegate.markFailed(id, error),
      markPublished: async (id, publishedAt) => {
        if (failOnce) { failOnce = false; throw new Error('simulated crash before outbox acknowledgement') }
        await delegate.markPublished(id, publishedAt)
      },
    }
    await repository.create(job())
    const service = new ReviewJobService(runtime, repository, undefined, queue, new NoopReviewPersistence(), outbox)
    assert.equal(await service.reconcileQueue('2026-09-02T00:01:00.000Z'), 0)
    assert.equal(await service.dispatchOutbox('2026-09-02T00:01:01.000Z'), 1)
    assert.equal((await queue.consume())?.jobId, 'outbox-job-1')
    assert.equal(await queue.consume(), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('dead letters are idempotent and can be redriven into a fresh job attempt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-dead-letter-'))
  try {
    const repository = new FileReviewJobRepository(path.join(dir, 'jobs'))
    const queue = new InMemoryReviewJobQueue()
    const outbox = new FileReviewJobOutbox(path.join(dir, 'outbox'))
    const failed = job('failed')
    await repository.create(failed)
    const message = { messageId: 'message-1', jobId: failed.jobId }
    await queue.deadLetter(message, failed.jobId, failed.error!, 'dead-letter:outbox-job-1:attempt:3')
    await queue.deadLetter(message, failed.jobId, failed.error!, 'dead-letter:outbox-job-1:attempt:3')
    const [deadLetter] = await queue.listDeadLetters()
    assert.ok(deadLetter)
    assert.equal((await queue.listDeadLetters()).length, 1)

    const service = new ReviewJobService(runtime, repository, undefined, queue, new NoopReviewPersistence(), outbox)
    const redriven = await service.redriveDeadLetter(deadLetter.id, '2026-09-02T00:05:00.000Z')
    assert.equal(redriven.status, 'queued')
    assert.equal(redriven.attempts, 0)
    assert.equal((await queue.consume())?.jobId, failed.jobId)
    assert.equal((await queue.listDeadLetters()).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('retry delay uses capped exponential backoff', () => {
  assert.equal(retryDelayMs(1), 1_000)
  assert.equal(retryDelayMs(2), 2_000)
  assert.equal(retryDelayMs(3), 4_000)
  assert.equal(retryDelayMs(99), 60_000)
})
