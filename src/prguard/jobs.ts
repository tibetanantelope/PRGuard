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
  type ReviewDeadLetter,
} from './queue.js'
import type { PrDiffSnapshot, ReviewInput, ReviewResult } from './types.js'
import { createDefaultReviewPersistence, type ReviewPersistence } from './review-persistence.js'
import { logPrGuardEvent, prGuardMetrics } from './observability.js'
import { abortError } from '../abort.js'
import { publishGithubReviewFeedback } from './github.js'
import { assertReviewJobTransition, isTerminalReviewJobStatus, type ReviewJobStatus } from './job-state.js'
import type { JobLease } from './job-repository.js'
import { createDefaultReviewJobOutbox, type ReviewJobOutbox } from './job-outbox.js'

export type { ReviewJobStatus } from './job-state.js'

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
  fencingToken: number
  leaseOwner?: string
  leaseExpiresAt?: string
  runId?: string
  result?: ReviewResult
  error?: string
  githubFeedbackPublishedAt?: string
  publishFeedback?: boolean
  createdBy?: string
}

export class ReviewJobService {
  private readonly workerId = `worker-${process.pid}-${randomUUID()}`
  private readonly githubFeedbackAttemptedAt = new Map<string, number>()

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
    private readonly outbox: ReviewJobOutbox = createDefaultReviewJobOutbox(undefined, runtime.prGuardMySqlUrl),
  ) {}

  async create(snapshot: PrDiffSnapshot, multiAgent = false, options: { publishFeedback?: boolean; createdBy?: string } = {}): Promise<ReviewJob> {
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
      fencingToken: 0,
      publishFeedback: options.publishFeedback === true,
      createdBy: options.createdBy,
    }
    await this.repository.create(job)
    await this.scheduleEnqueue(job, now)
    await this.dispatchOutbox(now)
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
    if (isTerminalReviewJobStatus(current.status)) return current
    const job = await this.repository.claim(
      jobId,
      this.workerId,
      new Date().toISOString(),
      this.runtime.prGuardRedisReclaimIdleMs ?? 30_000,
    )
    if (!job) return null
    const lease: JobLease = { owner: this.workerId, fencingToken: job.fencingToken }
    let trace: PrGuardTrace | undefined
    const leaseDurationMs = this.runtime.prGuardRedisReclaimIdleMs ?? 30_000
    const heartbeat = setInterval(() => {
      void this.heartbeat(jobId, lease).catch(error => {
        logPrGuardEvent('review_job_heartbeat_failed', {
          jobId,
          fencingToken: lease.fencingToken,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, Math.max(1_000, Math.floor(leaseDurationMs / 3)))
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
      await trace.flush()
      await this.persistence.saveTrace(await new TraceService(this.traceBaseDir).load(trace.runId))
      const events = await new TraceService(this.traceBaseDir).load(trace.runId)
      const completed = await this.updateClaimed(job, lease, { status: 'completed', runId: trace.runId, result })
      await this.publishGithubFeedback(completed, trace)
      prGuardMetrics.recordTrace(events)
      prGuardMetrics.increment('prguard_jobs_total', { status: 'completed' })
      prGuardMetrics.observe('prguard_job_duration_ms', performance.now() - startedAt)
      logPrGuardEvent('review_job_completed', { jobId, runId: trace.runId, findingCount: result.findings.length })
      return completed
    } catch (error) {
      if (error instanceof LeaseLostError) return null
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
      try {
        return await this.updateClaimed(job, lease, { status, runId: trace?.runId, error: message })
      } catch (updateError) {
        if (updateError instanceof LeaseLostError) return null
        throw updateError
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  async retry(job: ReviewJob, now = new Date().toISOString()): Promise<ReviewJob> {
    const current = await this.repository.get(job.jobId)
    if (current.status === 'queued') return current
    if (current.attempts >= current.maxAttempts) return current
    assertReviewJobTransition(current.status, 'queued')
    const queued = {
      ...current,
      status: 'queued' as const,
      error: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    }
    if (!await this.repository.update(queued, undefined, current.updatedAt)) return this.repository.get(job.jobId)
    await this.scheduleEnqueue(queued, new Date(Date.parse(now) + retryDelayMs(queued.attempts)).toISOString())
    return queued
  }

  async dispatchOutbox(now = new Date().toISOString()): Promise<number> {
    let published = 0
    for (const event of await this.outbox.due(now)) {
      try {
        await this.queue.enqueue(event.jobId, event.idempotencyKey)
        if (event.sourceDeadLetterId) await this.queue.removeDeadLetter(event.sourceDeadLetterId)
        await this.outbox.markPublished(event.id, now)
        published += 1
      } catch (error) {
        await this.outbox.markFailed(event.id, error instanceof Error ? error.message : String(error))
      }
    }
    return published
  }

  async reconcileQueue(now = new Date().toISOString()): Promise<number> {
    for (const job of await this.repository.list()) {
      if (job.status === 'queued') await this.scheduleEnqueue(job, now)
    }
    const published = await this.dispatchOutbox(now)
    await this.reconcileGithubFeedback()
    return published
  }

  listDeadLetters(limit?: number): Promise<ReviewDeadLetter[]> {
    return this.queue.listDeadLetters(limit)
  }

  async redriveDeadLetter(deadLetterId: string, now = new Date().toISOString()): Promise<ReviewJob> {
    const deadLetter = (await this.queue.listDeadLetters(1000)).find(item => item.id === deadLetterId)
    if (!deadLetter) throw new Error(`PRGuard dead letter not found: ${deadLetterId}`)
    const current = await this.repository.get(deadLetter.jobId)
    if (current.status === 'completed' || current.status === 'running') {
      throw new Error(`Cannot redrive PRGuard job in ${current.status} state.`)
    }
    const queued: ReviewJob = {
      ...current, status: 'queued', attempts: 0, error: undefined,
      leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now,
    }
    assertReviewJobTransition(current.status, 'queued')
    if (!await this.repository.update(queued, undefined, current.updatedAt)) {
      throw new Error(`Concurrent PRGuard dead-letter redrive rejected: ${current.jobId}`)
    }
    await this.scheduleEnqueue(queued, now, deadLetterId)
    await this.dispatchOutbox(now)
    return queued
  }

  async heartbeat(jobId: string, lease: JobLease): Promise<void> {
    const now = new Date().toISOString()
    const ok = await this.repository.heartbeat(
      jobId,
      lease,
      now,
      this.runtime.prGuardRedisReclaimIdleMs ?? 30_000,
    )
    if (!ok) throw new LeaseLostError(jobId, lease.fencingToken)
  }

  async heartbeatMessage(message: ReviewQueueMessage): Promise<void> {
    await this.queue.heartbeat(message)
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
    return this.queue.deadLetter(
      message,
      job.jobId,
      job.error ?? 'unknown error',
      `dead-letter:${job.jobId}:attempt:${job.attempts}`,
    )
  }

  private async update(jobId: string, update: Partial<ReviewJob>): Promise<ReviewJob> {
    const job = await this.repository.get(jobId)
    if (update.status && update.status !== job.status) assertReviewJobTransition(job.status, update.status)
    const updated = { ...job, ...update, updatedAt: new Date().toISOString() }
    if (!await this.repository.update(updated, undefined, job.updatedAt)) throw new Error(`Concurrent PRGuard job update rejected: ${jobId}`)
    return updated
  }

  private async updateClaimed(job: ReviewJob, lease: JobLease, update: Partial<ReviewJob>): Promise<ReviewJob> {
    const updated = { ...job, ...update, updatedAt: new Date().toISOString() }
    if (updated.status !== job.status) assertReviewJobTransition(job.status, updated.status)
    if (!await this.repository.update(updated, lease)) {
      throw new LeaseLostError(job.jobId, lease.fencingToken)
    }
    return updated
  }

  private async scheduleEnqueue(job: ReviewJob, availableAt: string, sourceDeadLetterId?: string): Promise<void> {
    await this.outbox.schedule({
      jobId: job.jobId,
      kind: 'enqueue',
      idempotencyKey: `enqueue:${job.jobId}:attempt:${job.attempts}:fence:${job.fencingToken}`,
      availableAt,
      createdAt: new Date().toISOString(),
      sourceDeadLetterId,
    })
  }

  private async reconcileGithubFeedback(): Promise<void> {
    if (!this.runtime.prGuardGithubFeedbackEnabled || !this.runtime.prGuardGithubToken) return
    for (const job of await this.repository.list()) {
      if (job.status === 'completed' && !job.githubFeedbackPublishedAt) {
        await this.publishGithubFeedback(job)
      }
    }
  }

  private async publishGithubFeedback(job: ReviewJob, trace?: PrGuardTrace): Promise<void> {
    if (!job.publishFeedback || !this.runtime.prGuardGithubFeedbackEnabled || !this.runtime.prGuardGithubToken
      || !job.input.githubRef || !job.input.githubSha || !job.result || job.githubFeedbackPublishedAt) return
    const lastAttempt = this.githubFeedbackAttemptedAt.get(job.jobId) ?? 0
    if (Date.now() - lastAttempt < 5_000) return
    this.githubFeedbackAttemptedAt.set(job.jobId, Date.now())
    try {
      await publishGithubReviewFeedback(job.input.githubRef, job.input.githubSha, job.result, {
        token: this.runtime.prGuardGithubToken,
        idempotencyKey: `github-feedback:${job.jobId}:${job.result.reviewId}`,
      })
      await trace?.record('checkpoint', { phase: 'github_feedback_published' })
      await trace?.flush()
      const marked = { ...job, githubFeedbackPublishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      await this.repository.update(marked, undefined, job.updatedAt)
    } catch (error) {
      logPrGuardEvent('github_feedback_failed', { jobId: job.jobId, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function retryDelayMs(attempts: number, baseMs = 1_000, maxMs = 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1))
}

export class LeaseLostError extends Error {
  constructor(readonly jobId: string, readonly fencingToken: number) {
    super(`PRGuard job lease lost: ${jobId} fencingToken=${fencingToken}`)
    this.name = 'LeaseLostError'
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
      await this.service.reconcileQueue()
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
      let shouldAck = false
      try {
        const job = await this.service.process(message.jobId, { signal: options.signal })
        if (!job) continue
        if (job?.status === 'failed' || job?.status === 'timed_out' || job?.status === 'cancelled') {
          if (job.attempts < job.maxAttempts) {
            await this.service.retry(job)
          } else {
            await this.service.deadLetter(message, job)
          }
        }
        shouldAck = true
      } finally {
        clearInterval(heartbeat)
        if (shouldAck) await this.service.ack(message)
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
