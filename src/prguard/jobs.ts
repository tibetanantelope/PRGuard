import { randomUUID } from 'node:crypto'
import type { RuntimeConfig } from '../config.js'
import { loadPrDiffSnapshot } from './repository.js'
import { ReviewService, TraceService } from './services.js'
import type { PrGuardTrace } from './trace.js'
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
import { abortError } from '../abort.js'
import { publishGithubReviewFeedback } from './github.js'

export type ReviewJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

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
    private readonly queue: ReviewJobQueue = createDefaultReviewJobQueue(runtime.prGuardRedisUrl, {
      reclaimIdleMs: runtime.prGuardRedisReclaimIdleMs,
    }),
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

  async process(jobId: string, options: { signal?: AbortSignal } = {}): Promise<ReviewJob | null> {
    const startedAt = performance.now()
    const current = await this.get(jobId)
    if (current.status === 'completed') return current
    const job = await this.repository.claim(
      jobId,
      new Date().toISOString(),
      this.runtime.prGuardRedisReclaimIdleMs ?? 30_000,
    )
    if (!job) return null
    let trace: PrGuardTrace | undefined
    const heartbeat = setInterval(() => {
      void this.heartbeat(jobId)
    }, 5_000)
    try {
      const snapshot = await loadPrDiffSnapshot(job.input)
      trace = await new TraceService(this.traceBaseDir).create(snapshot.input)
      const result = await withTimeout(
        signal => new ReviewService(this.runtime, this.persistence).review(snapshot, {
          multiAgent: job.multiAgent,
          trace,
          jobId,
          signal,
        }),
        this.runtime.prGuardReviewTimeoutMs ?? 120_000,
        options.signal,
      )
      await trace.record('run_finished', { status: 'review_completed' })
      if (
        this.runtime.prGuardGithubFeedbackEnabled
        && this.runtime.prGuardGithubToken
        && job.input.githubRef
        && job.input.githubSha
      ) {
        try {
          await publishGithubReviewFeedback(job.input.githubRef, job.input.githubSha, result, {
            token: this.runtime.prGuardGithubToken,
          })
          await trace.record('checkpoint', { phase: 'github_feedback_published' })
        } catch (feedbackError) {
          await trace.record('checkpoint', {
            phase: 'github_feedback_failed',
            error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
          })
          logPrGuardEvent('github_feedback_failed', { jobId, error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError) })
        }
      }
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
      const status: ReviewJobStatus = error instanceof ReviewTimeoutError
        ? 'timed_out'
        : options.signal?.aborted
          ? 'cancelled'
          : 'failed'
      prGuardMetrics.increment('prguard_jobs_total', { status })
      prGuardMetrics.observe('prguard_job_duration_ms', performance.now() - startedAt)
      logPrGuardEvent('review_job_failed', { jobId, runId: trace?.runId, status, error: message })
      return await this.update(jobId, { status, runId: trace?.runId, error: message })
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

  async heartbeatMessage(message: ReviewQueueMessage): Promise<void> {
    await this.queue.heartbeat(message)
    await this.heartbeat(message.jobId)
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
  reclaimIdleMs?: number
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
      const heartbeat = setInterval(() => {
        void this.service.heartbeatMessage(message).catch(error => {
          logPrGuardEvent('review_queue_heartbeat_failed', {
            jobId: message.jobId,
            messageId: message.messageId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }, Math.max(1_000, Math.floor((options.reclaimIdleMs ?? 30_000) / 3)))
      try {
        const job = await this.service.process(message.jobId, { signal: options.signal })
        if (job?.status === 'failed' || job?.status === 'timed_out' || job?.status === 'cancelled') {
          if (job.attempts < job.maxAttempts) {
            await this.service.retry(job)
          } else {
            await this.service.deadLetter(message, job)
          }
        }
      } finally {
        clearInterval(heartbeat)
        await this.service.ack(message)
      }
    }
  }
}

export class ReviewTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Review timed out after ${timeoutMs} ms`)
    this.name = 'ReviewTimeoutError'
  }
}

export function withTimeout<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const task = typeof operation === 'function'
    ? Promise.resolve().then(() => operation(controller.signal))
    : operation
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
      callback()
    }
    const timer = setTimeout(() => {
      const error = new ReviewTimeoutError(timeoutMs)
      controller.abort(error)
      finish(() => reject(error))
    }, timeoutMs)
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason)
      finish(() => reject(abortError(parentSignal)))
      return
    }
    task.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
