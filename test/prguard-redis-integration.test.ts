import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import { test } from 'node:test'
import { RedisReviewJobQueue } from '../src/prguard/queue.js'

test('Redis Streams reclaims an abandoned message and ACKs it', { skip: !process.env.PRGUARD_REDIS_INTEGRATION }, async () => {
  const url = process.env.PR_GUARD_REDIS_URL?.trim() || 'redis://127.0.0.1:6380'
  const suffix = randomUUID().replaceAll('-', '')
  const stream = `prguard:integration:${suffix}`
  const group = `group-${suffix}`
  const firstConsumer = `worker-1-${suffix}`
  const secondConsumer = `worker-2-${suffix}`
  const cleanup = createClient({ url })
  const first = new RedisReviewJobQueue({
    url,
    stream,
    group,
    consumer: firstConsumer,
    blockMs: 100,
    reclaimIdleMs: 100,
  })
  const second = new RedisReviewJobQueue({
    url,
    stream,
    group,
    consumer: secondConsumer,
    blockMs: 100,
    reclaimIdleMs: 100,
  })

  try {
    await first.enqueue('integration-job')
    const abandoned = await first.consume()
    assert.ok(abandoned)
    await first.close()

    await delay(150)
    const reclaimed = await second.consume()
    assert.deepEqual(reclaimed?.jobId, 'integration-job')
    assert.equal(reclaimed?.messageId, abandoned.messageId)
    await second.ack(reclaimed!)

    await cleanup.connect()
    const pending = await cleanup.xPending(stream, group)
    assert.equal(pending.pending, 0)
  } finally {
    await second.close()
    if (!cleanup.isOpen) await cleanup.connect()
    await cleanup.del(stream)
    await cleanup.quit()
  }
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
