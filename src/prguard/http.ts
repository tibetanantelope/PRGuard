import http from 'node:http'
import { URL } from 'node:url'
import type { RuntimeConfig } from '../config.js'
import { loadPrDiffSnapshot } from './repository.js'
import { RepairService, ReviewService, TraceService } from './services.js'
import { ReviewJobService, ReviewWorker } from './jobs.js'
import { createDefaultReviewJobRepository, type ReviewJobRepository } from './job-repository.js'
import { logPrGuardEvent, prGuardMetrics } from './observability.js'
import { loadGithubPrDiffSnapshot, parseGithubWebhookEvent, verifyGithubWebhookSignature } from './github.js'
import { timingSafeEqual } from 'node:crypto'
import { renderPrGuardAdmin } from './admin.js'

const MAX_BODY_BYTES = 10 * 1024 * 1024

export type PrGuardServerOptions = {
  runtime: RuntimeConfig
  host?: string
  port?: number
  traceBaseDir?: string
  jobBaseDir?: string
  jobRepository?: ReviewJobRepository
}

type JsonRecord = Record<string, unknown>

class FixedWindowRateLimiter {
  private readonly clients = new Map<string, { startedAt: number; count: number }>()

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(client: string): boolean {
    const now = Date.now()
    const current = this.clients.get(client)
    if (!current || now - current.startedAt >= this.windowMs) {
      this.clients.set(client, { startedAt: now, count: 1 })
      return true
    }
    current.count += 1
    return current.count <= this.limit
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body is too large. Maximum is ${MAX_BODY_BYTES} bytes.`))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<JsonRecord> {
  const body = await readBody(req)
  const value: unknown = JSON.parse(body.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.')
  }
  return value as JsonRecord
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPrGuardServer(options: PrGuardServerOptions): http.Server {
  const reviewService = new ReviewService(options.runtime)
  const repairService = new RepairService(options.runtime)
  const traceService = new TraceService(options.traceBaseDir)
  const jobRepository = options.jobRepository ?? createDefaultReviewJobRepository(
    options.jobBaseDir,
    options.runtime.prGuardMySqlUrl,
  )
  const jobService = new ReviewJobService(options.runtime, jobRepository, options.traceBaseDir)
  const workerAbort = new AbortController()
  const rateLimiter = new FixedWindowRateLimiter(options.runtime.prGuardRateLimitPerMinute ?? 120)
  if (!options.runtime.prGuardRedisUrl) {
    void new ReviewWorker(jobService).run({ signal: workerAbort.signal })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      const isHealth = method === 'GET' && url.pathname === '/healthz'
      const isWebhook = method === 'POST' && url.pathname === '/api/v1/github/webhook'
      const isAdminPage = method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')
      const client = req.socket.remoteAddress ?? 'unknown'
      if (!rateLimiter.allow(client)) {
        prGuardMetrics.increment('prguard_rate_limit_rejections_total')
        logPrGuardEvent('rate_limit_rejected', { client })
        json(res, 429, { error: 'Rate limit exceeded. Try again later.' })
        return
      }
      if (options.runtime.prGuardApiKey && !isHealth && !isWebhook && !isAdminPage && !hasApiKey(req, options.runtime.prGuardApiKey)) {
        prGuardMetrics.increment('prguard_auth_failures_total')
        logPrGuardEvent('api_auth_failed', { client, method, route: url.pathname })
        json(res, 401, { error: 'Authentication required.' })
        return
      }
      const requestStartedAt = performance.now()
      res.once('finish', () => {
        prGuardMetrics.increment('prguard_http_requests_total', { method, route: url.pathname, status: String(res.statusCode) })
        prGuardMetrics.observe('prguard_http_request_duration_ms', performance.now() - requestStartedAt, { method, route: url.pathname })
      })

      if (method === 'GET' && url.pathname === '/metrics') {
        res.statusCode = 200
        res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        res.end(prGuardMetrics.renderPrometheus())
        return
      }

      if (isAdminPage) {
        const payload = renderPrGuardAdmin()
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
        res.end(payload)
        return
      }

      if (method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok', service: 'prguard' })
        return
      }

      if (method === 'POST' && url.pathname === '/api/v1/github/webhook') {
        const body = await readBody(req)
        const secret = options.runtime.prGuardGithubWebhookSecret
        const signatureHeader = req.headers['x-hub-signature-256']
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
        if (!secret || !verifyGithubWebhookSignature(body, signature, secret)) {
          json(res, 401, { error: 'Invalid GitHub webhook signature.' })
          return
        }
        const eventName = String(req.headers['x-github-event'] ?? '')
        const payload = JSON.parse(body.toString('utf8')) as { action?: string }
        const supportedActions = new Set(['opened', 'reopened', 'synchronize'])
        if (eventName !== 'pull_request' || !supportedActions.has(payload.action ?? '')) {
          json(res, 202, { accepted: true, ignored: true, reason: 'event_not_supported' })
          return
        }
        const reference = parseGithubWebhookEvent(payload)
        if (!reference || !options.runtime.prGuardGithubWorkspace) {
          json(res, 400, { error: 'Webhook payload or PR_GUARD_GITHUB_WORKSPACE is invalid.' })
          return
        }
        const snapshot = await loadGithubPrDiffSnapshot({
          cwd: options.runtime.prGuardGithubWorkspace,
          githubRef: `${reference.owner}/${reference.repo}#${reference.number}`,
          token: options.runtime.prGuardGithubToken,
        })
        const job = await jobService.create(snapshot, true)
        logPrGuardEvent('github_review_job_enqueued', { jobId: job.jobId, githubRef: snapshot.input.githubRef })
        json(res, 202, { accepted: true, jobId: job.jobId, githubRef: snapshot.input.githubRef })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/traces') {
        json(res, 200, { traces: await traceService.list() })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/review-jobs') {
        json(res, 200, { jobs: await jobService.list() })
        return
      }

      const jobMatch = url.pathname.match(/^\/api\/v1\/review-jobs\/([^/]+)$/)
      if (method === 'GET' && jobMatch) {
        json(res, 200, await jobService.get(jobMatch[1]))
        return
      }

      const repairMatch = url.pathname.match(/^\/api\/v1\/review-jobs\/([^/]+)\/repair$/)
      if (method === 'POST' && repairMatch) {
        const body = await readJson(req)
        const job = await jobService.get(repairMatch[1])
        if (job.status !== 'completed' || !job.result) {
          json(res, 409, { error: 'Repair requires a completed review job.' })
          return
        }
        const findingIds = Array.isArray(body.findingIds)
          ? body.findingIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : []
        if (findingIds.length === 0) {
          json(res, 400, { error: 'findingIds must contain at least one Finding ID.' })
          return
        }
        const apply = body.apply === true
        const testCommand = typeof body.testCommand === 'string' ? body.testCommand.trim() : ''
        if (apply && !testCommand) {
          json(res, 400, { error: 'testCommand is required when apply is true.' })
          return
        }

        const snapshot = await loadPrDiffSnapshot(job.input)
        const trace = await traceService.create(snapshot.input)
        try {
          const patch = await repairService.generate(snapshot, job.result, findingIds, trace)
          if (!apply) {
            await trace.record('run_finished', { status: 'patch_generated', findingIds: patch.findingIds })
            await trace.flush()
            json(res, 200, { status: 'patch_generated', runId: trace.runId, patch })
            return
          }

          const result = await repairService.apply(snapshot.input.cwd, patch, testCommand, trace)
          await trace.record('run_finished', { status: result.patch.status, findingIds: patch.findingIds })
          await trace.flush()
          json(res, 200, { status: result.patch.status, runId: trace.runId, ...result })
        } catch (error) {
          await trace.record('run_failed', { phase: 'repair', error: errorMessage(error) })
          await trace.flush()
          throw error
        }
        return
      }

      const traceMatch = url.pathname.match(/^\/api\/v1\/traces\/([^/]+)$/)
      if (method === 'GET' && traceMatch) {
        json(res, 200, { runId: traceMatch[1], events: await traceService.load(traceMatch[1]) })
        return
      }

      if (method === 'POST' && url.pathname === '/api/v1/reviews') {
        const body = await readJson(req)
        const snapshot = await loadPrDiffSnapshot(body)
        const multiAgent = body.multiAgent === true
        const trace = await traceService.create(snapshot.input)
        try {
          const review = await reviewService.review(snapshot, { multiAgent, trace })
          await trace.record('run_finished', { status: 'review_completed' })
          await trace.flush()
          prGuardMetrics.recordTrace(await traceService.load(trace.runId))
          logPrGuardEvent('review_completed', { runId: trace.runId, findingCount: review.findings.length, multiAgent })
          json(res, 200, { runId: trace.runId, review })
        } catch (error) {
          await trace.record('run_failed', { phase: 'review', error: errorMessage(error) })
          await trace.flush()
          throw error
        }
        return
      }

      if (method === 'POST' && url.pathname === '/api/v1/review-jobs') {
        const body = await readJson(req)
        const snapshot = await loadPrDiffSnapshot(body)
        const job = await jobService.create(snapshot, body.multiAgent === true)
        json(res, 202, job)
        return
      }

      json(res, 404, { error: 'Not found' })
    } catch (error) {
      const message = errorMessage(error)
      const status = /Invalid PR review input|Request body|JSON/.test(message) ? 400 : 500
      json(res, status, { error: message })
    }
  })
  server.once('close', () => {
    workerAbort.abort()
    void jobService.close()
  })
  return server
}

function hasApiKey(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization
  const provided = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : ''
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function startPrGuardServer(options: PrGuardServerOptions): Promise<http.Server> {
  const server = createPrGuardServer(options)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1')
  })
  return server
}
