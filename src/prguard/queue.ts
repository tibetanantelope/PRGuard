import { randomUUID } from 'node:crypto'
import { createClient } from 'redis'

export type ReviewQueueMessage = {
  messageId: string
  jobId: string
}

export type ReviewJobQueue = {
  enqueue(jobId: string): Promise<void>
  consume(): Promise<ReviewQueueMessage | null>
  ack(message: ReviewQueueMessage): Promise<void>
  deadLetter(message: ReviewQueueMessage, jobId: string, error: string): Promise<void>
  close(): Promise<void>
}

export class InMemoryReviewJobQueue implements ReviewJobQueue {
  private readonly pending: string[] = []

  async enqueue(jobId: string): Promise<void> {
    this.pending.push(jobId)
  }

  async consume(): Promise<ReviewQueueMessage | null> {
    const jobId = this.pending.shift()
    return jobId ? { messageId: `local-${randomUUID()}`, jobId } : null
  }

  async ack(_message: ReviewQueueMessage): Promise<void> {}

  async deadLetter(_message: ReviewQueueMessage, _jobId: string, _error: string): Promise<void> {}

  async close(): Promise<void> {}
}

export type RedisReviewJobQueueOptions = {
  url: string
  stream?: string
  group?: string
  consumer?: string
  blockMs?: number
}

export class RedisReviewJobQueue implements ReviewJobQueue {
  private readonly client: ReturnType<typeof createClient>
  private initialized: Promise<void> | undefined

  constructor(private readonly options: RedisReviewJobQueueOptions) {
    this.client = createClient({ url: options.url })
  }

  async enqueue(jobId: string): Promise<void> {
    await this.ensureReady()
    await this.client.xAdd(this.stream, '*', { jobId })
  }

  async consume(): Promise<ReviewQueueMessage | null> {
    await this.ensureReady()
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
    return { messageId: message.id, jobId }
  }

  async ack(message: ReviewQueueMessage): Promise<void> {
    await this.ensureReady()
    await this.client.xAck(this.stream, this.group, message.messageId)
  }

  async deadLetter(message: ReviewQueueMessage, jobId: string, error: string): Promise<void> {
    await this.ensureReady()
    await this.client.xAdd(`${this.stream}:dead-letter`, '*', {
      originalMessageId: message.messageId,
      jobId,
      error,
    })
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

export function createDefaultReviewJobQueue(redisUrl?: string): ReviewJobQueue {
  const url = redisUrl?.trim() || process.env.PR_GUARD_REDIS_URL?.trim()
  if (!url) return new InMemoryReviewJobQueue()
  return new RedisReviewJobQueue({ url })
}
