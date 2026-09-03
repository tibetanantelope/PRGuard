import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'
import { prGuardMetrics } from './observability.js'

export type ReviewQueueMessage = {
  messageId: string
  jobId: string
}

export type ReviewDeadLetter = {
  id: string
  originalMessageId: string
  jobId: string
  error: string
  idempotencyKey: string
}

export type ReviewJobQueue = {
  enqueue(jobId: string, idempotencyKey?: string): Promise<void>
  consume(): Promise<ReviewQueueMessage | null>
  heartbeat(message: ReviewQueueMessage): Promise<void>
  ack(message: ReviewQueueMessage): Promise<void>
  deadLetter(message: ReviewQueueMessage, jobId: string, error: string, idempotencyKey: string): Promise<void>
  listDeadLetters(limit?: number): Promise<ReviewDeadLetter[]>
  removeDeadLetter(id: string): Promise<void>
  close(): Promise<void>
}

export class InMemoryReviewJobQueue implements ReviewJobQueue {
  private readonly pending: string[] = []
  private readonly publishedKeys = new Set<string>()
  private readonly deadLetters = new Map<string, ReviewDeadLetter>()

  async enqueue(jobId: string, idempotencyKey?: string): Promise<void> {
    if (idempotencyKey && this.publishedKeys.has(idempotencyKey)) return
    if (idempotencyKey) this.publishedKeys.add(idempotencyKey)
    this.pending.push(jobId)
    prGuardMetrics.increment('prguard_queue_enqueued_total')
  }

  async consume(): Promise<ReviewQueueMessage | null> {
    const jobId = this.pending.shift()
    return jobId ? { messageId: `local-${randomUUID()}`, jobId } : null
  }

  async heartbeat(_message: ReviewQueueMessage): Promise<void> {}

  async ack(_message: ReviewQueueMessage): Promise<void> {}

  async deadLetter(message: ReviewQueueMessage, jobId: string, error: string, idempotencyKey: string): Promise<void> {
    if ([...this.deadLetters.values()].some(item => item.idempotencyKey === idempotencyKey)) return
    const id = `dead-${randomUUID()}`
    this.deadLetters.set(id, { id, originalMessageId: message.messageId, jobId, error, idempotencyKey })
  }

  async listDeadLetters(limit = 100): Promise<ReviewDeadLetter[]> {
    return [...this.deadLetters.values()].slice(0, limit)
  }

  async removeDeadLetter(id: string): Promise<void> {
    this.deadLetters.delete(id)
  }

  async close(): Promise<void> {}
}

export type RedisReviewJobQueueOptions = {
  url: string
  stream?: string
  group?: string
  consumer?: string
  blockMs?: number
  reclaimIdleMs?: number
  reclaimCount?: number
}

export class RedisReviewJobQueue implements ReviewJobQueue {
  private readonly client: ReturnType<typeof createClient>
  private initialized: Promise<void> | undefined

  constructor(private readonly options: RedisReviewJobQueueOptions) {
    this.client = createClient({ url: options.url })
  }

  async enqueue(jobId: string, idempotencyKey?: string): Promise<void> {
    await this.ensureReady()
    if (idempotencyKey) {
      const published = await this.client.eval(
        `if redis.call('SET', KEYS[1], '1', 'NX', 'EX', 604800) then
           return redis.call('XADD', KEYS[2], '*', 'jobId', ARGV[1], 'idempotencyKey', ARGV[2])
         end
         return false`,
        { keys: [`${this.stream}:idempotency:${idempotencyKey}`, this.stream], arguments: [jobId, idempotencyKey] },
      )
      if (!published) return
    } else {
      await this.client.xAdd(this.stream, '*', { jobId })
    }
    prGuardMetrics.increment('prguard_queue_enqueued_total')
  }

  async consume(): Promise<ReviewQueueMessage | null> {
    await this.ensureReady()
    const reclaimed = await this.reclaimPending()
    if (reclaimed) {
      prGuardMetrics.increment('prguard_queue_reclaimed_total')
      return reclaimed
    }
    const result = await this.client.xReadGroup(
      this.group,
      this.consumer,
      [{ key: this.stream, id: '>' }],
      { COUNT: 1, BLOCK: this.options.blockMs ?? 1000 },
    )
    const messages = result as unknown as RedisReadResult | null
    const message = messages?.[0]?.messages[0]
    if (!message) return null
    const jobId = message.message.jobId
    if (!jobId) throw new Error(`Redis message ${message.id} does not contain jobId`)
    prGuardMetrics.increment('prguard_queue_consumed_total')
    await this.refreshPendingMetric()
    return { messageId: message.id, jobId }
  }

  async heartbeat(message: ReviewQueueMessage): Promise<void> {
    await this.ensureReady()
    await this.client.xClaim(this.stream, this.group, this.consumer, 0, [message.messageId])
  }

  async ack(message: ReviewQueueMessage): Promise<void> {
    await this.ensureReady()
    await this.client.xAck(this.stream, this.group, message.messageId)
    prGuardMetrics.increment('prguard_queue_acked_total')
    await this.refreshPendingMetric()
  }

  async deadLetter(message: ReviewQueueMessage, jobId: string, error: string, idempotencyKey: string): Promise<void> {
    await this.ensureReady()
    const published = await this.client.eval(
      `if redis.call('SET', KEYS[1], '1', 'NX', 'EX', 2592000) then
         return redis.call('XADD', KEYS[2], '*', 'originalMessageId', ARGV[1], 'jobId', ARGV[2], 'error', ARGV[3], 'idempotencyKey', ARGV[4])
       end
       return false`,
      { keys: [`${this.stream}:dead-letter:idempotency:${idempotencyKey}`, `${this.stream}:dead-letter`], arguments: [message.messageId, jobId, error, idempotencyKey] },
    )
    if (!published) return
    prGuardMetrics.increment('prguard_queue_dead_letter_total')
  }

  async listDeadLetters(limit = 100): Promise<ReviewDeadLetter[]> {
    await this.ensureReady()
    const records = await this.client.xRange(`${this.stream}:dead-letter`, '-', '+', { COUNT: limit })
    return records.map(record => ({
      id: record.id,
      originalMessageId: record.message.originalMessageId ?? '',
      jobId: record.message.jobId ?? '',
      error: record.message.error ?? '',
      idempotencyKey: record.message.idempotencyKey ?? record.id,
    }))
  }

  async removeDeadLetter(id: string): Promise<void> {
    await this.ensureReady()
    await this.client.xDel(`${this.stream}:dead-letter`, id)
  }

  private async reclaimPending(): Promise<ReviewQueueMessage | null> {
    const result = await this.client.xAutoClaim(
      this.stream,
      this.group,
      this.consumer,
      this.options.reclaimIdleMs ?? 30_000,
      '0-0',
      { COUNT: this.options.reclaimCount ?? 1 },
    )
    const message = result.messages.find(item => item !== null)
    if (!message) return null
    const jobId = message.message.jobId
    if (!jobId) throw new Error(`Redis message ${message.id} does not contain jobId`)
    return { messageId: message.id, jobId }
  }

  private async refreshPendingMetric(): Promise<void> {
    const summary = await this.client.xPending(this.stream, this.group)
    prGuardMetrics.set('prguard_queue_pending_jobs', summary.pending)
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit()
  }

  private get stream(): string {
    return this.options.stream ?? 'prguard:review-jobs'
  }

  private get group(): string {
    return this.options.group ?? 'prguard-workers'
  }

  private get consumer(): string {
    return this.options.consumer ?? `worker-${process.pid}-${randomUUID()}`
  }

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.connectAndPrepare()
    }
    await this.initialized
  }

  private async connectAndPrepare(): Promise<void> {
    await this.client.connect()
    try {
      await this.client.xGroupCreate(this.stream, this.group, '0', { MKSTREAM: true })
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error
    }
  }
}

type RedisReadResult = Array<{
  messages: Array<{ id: string; message: Record<string, string> }>
}>

export function createDefaultReviewJobQueue(
  redisUrl?: string,
  options: Omit<RedisReviewJobQueueOptions, 'url'> = {},
): ReviewJobQueue {
  const url = redisUrl?.trim() || process.env.PR_GUARD_REDIS_URL?.trim()
  if (!url) return new InMemoryReviewJobQueue()
  return new RedisReviewJobQueue({ url, ...options })
}
