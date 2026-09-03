import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { FileReviewJobRepository } from '../src/prguard/job-repository.js'
import type { ReviewJob } from '../src/prguard/jobs.js'
import { assertReviewJobTransition, canTransitionReviewJob } from '../src/prguard/job-state.js'
import { ReviewJobService } from '../src/prguard/jobs.js'
import { InMemoryReviewJobQueue } from '../src/prguard/queue.js'
import { NoopReviewPersistence } from '../src/prguard/review-persistence.js'
import type { RuntimeConfig } from '../src/config.js'
import { FileReviewJobOutbox } from '../src/prguard/job-outbox.js'

const job: ReviewJob = {
  jobId: 'job-test-1',
  status: 'queued',
  multiAgent: true,
  cwd: 'D:/workspace/demo',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  attempts: 0,
  maxAttempts: 3,
  fencingToken: 0,
}

const runtime: RuntimeConfig = {
  model: 'test-model', baseUrl: 'http://localhost', apiKey: 'test', mcpServers: {}, sourceSummary: 'test',
}

describe('PRGuard job repositories', () => {
  it('persists and lists jobs through the file repository fallback', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-repository-'))
    try {
      const repository = new FileReviewJobRepository(baseDir)
      await repository.create(job)
      assert.deepEqual(await repository.get(job.jobId), job)

      const claimed = await repository.claim(job.jobId, 'worker-a', '2026-08-23T00:00:10.000Z', 30_000)
      const completed = { ...claimed!, status: 'completed' as const, updatedAt: '2026-08-23T00:00:20.000Z' }
      assert.equal(await repository.update(completed, { owner: 'worker-a', fencingToken: 1 }), true)
      assert.equal((await repository.list())[0]?.status, 'completed')
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('claims a queued job once and does not reclaim a running job', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-claim-'))
    try {
      const repository = new FileReviewJobRepository(baseDir)
      await repository.create(job)
      const claimed = await repository.claim(job.jobId, 'worker-a', '2026-08-23T00:03:00.000Z', 30_000)
      assert.equal(claimed?.status, 'running')
      assert.equal(claimed?.attempts, 1)
      assert.equal(claimed?.leaseOwner, 'worker-a')
      assert.equal(claimed?.fencingToken, 1)
      assert.equal(await repository.claim(job.jobId, 'worker-b', '2026-08-23T00:03:00.001Z', 30_000), null)
      const recovered = await repository.claim(job.jobId, 'worker-b', '2026-08-23T00:04:00.000Z', 30_000)
      assert.equal(recovered?.status, 'running')
      assert.equal(recovered?.attempts, 2)
      assert.equal(recovered?.leaseOwner, 'worker-b')
      assert.equal(recovered?.fencingToken, 2)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('atomically allows only one worker to claim a queued file job', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-atomic-claim-'))
    try {
      const firstRepository = new FileReviewJobRepository(baseDir)
      const secondRepository = new FileReviewJobRepository(baseDir)
      await firstRepository.create(job)
      const claims = await Promise.all([
        firstRepository.claim(job.jobId, 'worker-a', '2026-08-23T00:01:00.000Z', 30_000),
        secondRepository.claim(job.jobId, 'worker-b', '2026-08-23T00:01:00.000Z', 30_000),
      ])
      assert.equal(claims.filter(Boolean).length, 1)
      assert.equal((await firstRepository.get(job.jobId)).attempts, 1)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('uses heartbeats and fencing tokens to reject a stale worker after takeover', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-fencing-'))
    try {
      const firstRepository = new FileReviewJobRepository(baseDir)
      const secondRepository = new FileReviewJobRepository(baseDir)
      await firstRepository.create(job)
      const first = await firstRepository.claim(job.jobId, 'worker-a', '2026-08-23T00:00:00.000Z', 30_000)
      const firstLease = { owner: 'worker-a', fencingToken: first!.fencingToken }
      assert.equal(await firstRepository.heartbeat(job.jobId, firstLease, '2026-08-23T00:00:20.000Z', 30_000), true)
      assert.equal((await firstRepository.get(job.jobId)).leaseExpiresAt, '2026-08-23T00:00:50.000Z')
      assert.equal(await secondRepository.heartbeat(job.jobId, { owner: 'intruder', fencingToken: 1 }, '2026-08-23T00:00:21.000Z', 30_000), false)

      const second = await secondRepository.claim(job.jobId, 'worker-b', '2026-08-23T00:00:51.000Z', 30_000)
      const staleCompletion = { ...first!, status: 'completed' as const, updatedAt: '2026-08-23T00:00:52.000Z' }
      assert.equal(await firstRepository.update(staleCompletion, firstLease), false)
      assert.equal(await firstRepository.heartbeat(job.jobId, firstLease, '2026-08-23T00:00:53.000Z', 30_000), false)

      const secondLease = { owner: 'worker-b', fencingToken: second!.fencingToken }
      const validCompletion = { ...second!, status: 'completed' as const, updatedAt: '2026-08-23T00:00:54.000Z' }
      assert.equal(await secondRepository.update(validCompletion, secondLease), true)
      const stored = await firstRepository.get(job.jobId)
      assert.equal(stored.status, 'completed')
      assert.equal(stored.fencingToken, 2)
      assert.equal(stored.leaseOwner, undefined)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('enforces the centralized job state machine', () => {
    assert.equal(canTransitionReviewJob('queued', 'running'), true)
    assert.equal(canTransitionReviewJob('running', 'completed'), true)
    assert.equal(canTransitionReviewJob('failed', 'queued'), true)
    assert.equal(canTransitionReviewJob('completed', 'running'), false)
    assert.throws(() => assertReviewJobTransition('completed', 'running'), /Invalid PRGuard job transition/)
  })

  it('uses optimistic concurrency to make concurrent retry idempotent', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-retry-race-'))
    try {
      const repository = new FileReviewJobRepository(baseDir)
      const queue = new InMemoryReviewJobQueue()
      const failed: ReviewJob = {
        ...job,
        status: 'failed',
        attempts: 1,
        fencingToken: 1,
        updatedAt: '2026-08-23T00:01:00.000Z',
      }
      await repository.create(failed)
      const outbox = new FileReviewJobOutbox(path.join(baseDir, 'outbox'))
      const service = new ReviewJobService(runtime, repository, undefined, queue, new NoopReviewPersistence(), outbox)
      await Promise.all([
        service.retry(failed, '2026-08-23T00:02:00.000Z'),
        service.retry(failed, '2026-08-23T00:02:00.000Z'),
      ])
      await service.dispatchOutbox('2026-08-23T00:02:02.000Z')
      assert.equal((await repository.get(job.jobId)).status, 'queued')
      assert.equal((await queue.consume())?.jobId, job.jobId)
      assert.equal(await queue.consume(), null)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
