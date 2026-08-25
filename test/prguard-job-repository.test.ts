import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { FileReviewJobRepository } from '../src/prguard/job-repository.js'
import type { ReviewJob } from '../src/prguard/jobs.js'

const job: ReviewJob = {
  jobId: 'job-test-1',
  status: 'queued',
  multiAgent: true,
  cwd: 'D:/workspace/demo',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}

describe('PRGuard job repositories', () => {
  it('persists and lists jobs through the file repository fallback', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-job-repository-'))
    try {
      const repository = new FileReviewJobRepository(baseDir)
      await repository.create(job)
      assert.deepEqual(await repository.get(job.jobId), job)

      const completed = { ...job, status: 'completed' as const, updatedAt: '2026-08-23T00:01:00.000Z' }
      await repository.update(completed)
      assert.equal((await repository.list())[0]?.status, 'completed')
      await repository.touch(job.jobId, '2026-08-23T00:02:00.000Z')
      assert.equal((await repository.get(job.jobId)).status, 'completed')
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
