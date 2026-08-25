import { randomUUID } from 'node:crypto'
import type { RuntimeConfig } from '../config.js'
import { loadPrDiffSnapshot } from './repository.js'
import { ReviewService, TraceService } from './services.js'
import {
  createDefaultReviewJobRepository,
  type ReviewJobRepository,
} from './job-repository.js'
import {
  createDefaultReviewJobQueue,
  type ReviewJobQueue,
  type ReviewQueueMessage,
} from './queue.js'
import type { PrDiffSnapshot, ReviewInput, ReviewResult } from './types.js'
import { createDefaultReviewPersistence, type ReviewPersistence } from './review-persistence.js'
import { logPrGuardEvent, prGuardMetrics } from './observability.js'

export type ReviewJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type ReviewJob = {
  jobId: string
  status: ReviewJobStatus
  multiAgent: boolean
  input: ReviewInput
  createdAt: string
  updatedAt: string
  cwd: string
  attempts: number
  maxAttempts: number
  runId?: string
  result?: ReviewResult
  error?: string
}

export class ReviewJobService {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly repository: ReviewJobRepository = createDefaultReviewJobRepository(
      undefined,
      runtime.prGuardMySqlUrl,
    ),
    private readonly traceBaseDir?: string,
    private readonly queue: ReviewJobQueue = createDefaultReviewJobQueue(runtime.prGuardRedisUrl),
    private readonly persistence: ReviewPersistence = createDefaultReviewPersistence(runtime.prGuardMySqlUrl),
  ) {}

  async create(snapshot: PrDiffSnapshot, multiAgent = false): Promise<ReviewJob> {
    const now = new Date().toISOString()
    const job: ReviewJob = {
      jobId: randomUUID(),
      status: 'queued',
      multiAgent,
      input: snapshot.input,
      createdAt: now,
      updatedAt: now,
      cwd: snapshot.input.cwd,
      attempts: 0,
      maxAttempts: this.runtime.prGuardMaxAttempts ?? 3,
    }
    await this.repository.create(job)
    try {
      await this.queue.enqueue(job.jobId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = await this.update(job.jobId, { status: 'failed', error: message })
      return failed
    }
    return job
  }

  get(jobId: string): Promise<ReviewJob> {
    return this.repository.get(jobId)
  }

  list(): Promise<ReviewJob[]> {
    return this.repository.list()
  }

  async process(jobId: string): Promise<ReviewJob> {
    const startedAt = performance.now()
    const current = await this.get(jobId)
    if (current.status === 'completed') return current
    const job = await this.update(jobId, {
      status: 'running',
      attempts: current.attempts + 1,
    })
    let trace
    const heartbeat = setInterval(() => {
      void this.heartbeat(jobId)
    }, 5_000)
    try {
      const snapshot = await loadPrDiffSnapshot(job.input)
      trace = await new TraceService(this.traceBaseDir).create(snapshot.input)
      const result = await withTimeout(
        new ReviewService(this.runtime, this.persistence).review(snapshot, { multiAgent: job.multiAgent, trace, jobId }),
        this.runtime.prGuardReviewTimeoutMs ?? 120_000,
      )
      await trace.record('run_finished', { status: 'review_completed' })
      await trace.flush()
      await this.persistence.saveTrace(await new TraceService(this.traceBaseDir).load(trace.runId))
      const events = await new TraceService(this.traceBaseDir).load(trace.runId)
      prGuardMetrics.recordTrace(events)
      prGuardMetrics.increment('prguard_jobs_total', { status: 'completed' })
      prGuardMetrics.observe('prguard_job_duration_ms', performance.now() - startedAt)
      logPrGuardEvent('review_job_completed', { jobId, runId: trace.runId, findingCount: result.findings.length })
      return await this.update(jobId, { status: 'completed', runId: trace.runId, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (trace) {
        await trace.record('run_failed', { phase: 'review', error: message })
        await trace.flush()
        try {
          await this.persistence.saveTrace(await new TraceService(this.traceBaseDir).load(trace.runId))
        } catch {
          // Preserve the original review error if trace persistence also fails.
        }
      }
      prGuardMetrics.increment('prguard_jobs_total', { status: 'failed' })
      prGuardMetrics.observe('prguard_job_duration_ms', performance.now() - startedAt)
      logPrGuardEvent('review_job_failed', { jobId, runId: trace?.runId, error: message })
      return await this.update(jobId, { status: 'failed', runId: trace?.runId, error: message })
    } finally {
      clearInterval(heartbeat)
    }
  }

  async retry(job: ReviewJob): Promise<ReviewJob> {
    const queued = await this.update(job.jobId, { status: 'queued', error: undefined })
    await this.queue.enqueue(queued.jobId)
    return queued
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.repository.touch(jobId, new Date().toISOString())
  }

  async close(): Promise<void> {
    await this.queue.close()
  }

  async consume(): Promise<ReviewQueueMessage | null> {
    return this.queue.consume()
  }

  ack(message: ReviewQueueMessage): Promise<void> {
    return this.queue.ack(message)
  }

  deadLetter(message: ReviewQueueMessage, job: ReviewJob): Promise<void> {
    return this.queue.deadLetter(message, job.jobId, job.error ?? 'unknown error')
  }

  private async update(jobId: string, update: Partial<ReviewJob>): Promise<ReviewJob> {
    const job = await this.repository.get(jobId)
    const updated = { ...job, ...update, updatedAt: new Date().toISOString() }
    await this.repository.update(updated)
    return updated
  }
}

export type ReviewWorkerOptions = {
  signal?: AbortSignal
  idleDelayMs?: number
}

export class ReviewWorker {
  constructor(private readonly service: ReviewJobService) {}

  async run(options: ReviewWorkerOptions = {}): Promise<void> {
    while (!options.signal?.aborted) {
      const message = await this.service.consume()
      if (!message) {
        await delay(options.idleDelayMs ?? 100)
        continue
      }
      try {
        const job = await this.service.process(message.jobId)
        if (job.status === 'failed') {
          if (job.attempts < job.maxAttempts) {
            await this.service.retry(job)
          } else {
            await this.service.deadLetter(message, job)
          }
        }
      } finally {
        await this.service.ack(message)
      }
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Review timed out after ${timeoutMs} ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
