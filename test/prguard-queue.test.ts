import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryReviewJobQueue } from '../src/prguard/queue.js'
import { withTimeout } from '../src/prguard/jobs.js'

describe('PRGuard job queue', () => {
  it('preserves FIFO order in the local fallback queue', async () => {
    const queue = new InMemoryReviewJobQueue()
    await queue.enqueue('job-1')
    await queue.enqueue('job-2')
    assert.equal((await queue.consume())?.jobId, 'job-1')
    assert.equal((await queue.consume())?.jobId, 'job-2')
    assert.equal(await queue.consume(), null)
  })

  it('fails a task that exceeds the configured timeout', async () => {
    await assert.rejects(
      withTimeout(new Promise(resolve => setTimeout(resolve, 30)), 5),
      /Review timed out after 5 ms/,
    )
  })
})
