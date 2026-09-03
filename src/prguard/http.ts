import http from 'node:http'
import { URL } from 'node:url'
import type { RuntimeConfig } from '../config.js'
import { loadPrDiffSnapshot } from './repository.js'
import { RepairService, ReviewService, TraceService } from './services.js'
import { ReviewJobService, ReviewWorker } from './jobs.js'
import { createDefaultReviewJobRepository, type ReviewJobRepository } from './job-repository.js'
import { logPrGuardEvent, prGuardMetrics } from './observability.js'
import { FileGithubWebhookDeliveryStore, loadGithubPrDiffSnapshot, parseGithubWebhookEvent, verifyGithubWebhookSignature, type GithubWebhookDeliveryStore } from './github.js'
import { randomUUID } from 'node:crypto'
import { renderPrGuardAdmin } from './admin.js'
import { PrGuardAuthorizer, projectAuthorizationId, systemPrincipal, type PrGuardAction } from './security.js'
import { PrGuardAuditLog } from './audit.js'
import { createPrGuardRateLimiter, type PrGuardRateLimiter } from './rate-limit.js'
import { checkVerificationSandbox, type SandboxReadiness } from './sandbox.js'

const MAX_BODY_BYTES = 10 * 1024 * 1024

export type PrGuardServerOptions = {
  runtime: RuntimeConfig
  host?: string
  port?: number
  traceBaseDir?: string
  jobBaseDir?: string
  jobRepository?: ReviewJobRepository
  githubDeliveryStore?: GithubWebhookDeliveryStore
  authorizer?: PrGuardAuthorizer
  auditLog?: PrGuardAuditLog
  rateLimiter?: PrGuardRateLimiter
  sandboxReadiness?: () => Promise<SandboxReadiness>
}

type JsonRecord = Record<string, unknown>

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
  const authorizer = options.authorizer ?? PrGuardAuthorizer.fromEnvironment(
    options.runtime.prGuardApiKey,
    options.runtime.prGuardRbacJson,
  )
  const bindHost = options.host ?? '127.0.0.1'
  const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1'
  if (!isLoopback && !authorizer.enabled) {
    throw new Error('Refusing to bind PRGuard API outside loopback without authentication.')
  }
  const reviewService = new ReviewService(options.runtime)
  const repairService = new RepairService(options.runtime)
  const traceService = new TraceService(options.traceBaseDir)
  const jobRepository = options.jobRepository ?? createDefaultReviewJobRepository(
    options.jobBaseDir,
    options.runtime.prGuardMySqlUrl,
  )
  const jobService = new ReviewJobService(options.runtime, jobRepository, options.traceBaseDir)
  const githubDeliveryStore = options.githubDeliveryStore ?? new FileGithubWebhookDeliveryStore(
    options.jobBaseDir ? `${options.jobBaseDir}/github-deliveries.json` : undefined,
  )
  const workerAbort = new AbortController()
  // The queue factory also honors PR_GUARD_REDIS_URL from the process environment.
  // Keep the worker lifecycle decision consistent with that factory so a test or
  // embedded caller cannot accidentally start a Redis worker and close it early.
  const redisUrl = options.runtime.prGuardRedisUrl ?? (process.env.PR_GUARD_REDIS_URL?.trim() || undefined)
  const rateLimiter = options.rateLimiter ?? createPrGuardRateLimiter(options.runtime.prGuardRateLimitPerMinute ?? 120, redisUrl)
  const auditLog = options.auditLog ?? new PrGuardAuditLog(options.jobBaseDir ? `${options.jobBaseDir}/audit.jsonl` : undefined)
  const sandboxReadiness = options.sandboxReadiness ?? (() =>
    checkVerificationSandbox(options.runtime.prGuardSandboxMode ?? 'docker'))
  if (!redisUrl) {
    void new ReviewWorker(jobService).run({
      signal: workerAbort.signal,
      reclaimIdleMs: options.runtime.prGuardRedisReclaimIdleMs,
    })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      const isHealth = method === 'GET' && url.pathname === '/healthz'
      const isReady = method === 'GET' && url.pathname === '/readyz'
      const isWebhook = method === 'POST' && url.pathname === '/api/v1/github/webhook'
      const isAdminPage = method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')
      const client = req.socket.remoteAddress ?? 'unknown'
      const suppliedCorrelationId = Array.isArray(req.headers['x-correlation-id']) ? req.headers['x-correlation-id'][0] : req.headers['x-correlation-id']
      const correlationId = typeof suppliedCorrelationId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(suppliedCorrelationId)
        ? suppliedCorrelationId : randomUUID()
      res.setHeader('x-correlation-id', correlationId)
      if (!await rateLimiter.allow(client)) {
        prGuardMetrics.increment('prguard_rate_limit_rejections_total')
        logPrGuardEvent('rate_limit_rejected', { client, correlationId })
        json(res, 429, { error: 'Rate limit exceeded. Try again later.', correlationId })
        return
      }
      const publicRoute = isHealth || isReady || isWebhook || isAdminPage
      const principal = authorizer.enabled ? authorizer.authenticate(bearerToken(req)) : systemPrincipal
      if (!publicRoute && !principal) {
        prGuardMetrics.increment('prguard_auth_failures_total')
        logPrGuardEvent('api_auth_failed', { client, method, route: url.pathname, correlationId })
        json(res, 401, { error: 'Authentication required.', correlationId })
        return
      }
      const requireAction = async (action: PrGuardAction, projectId?: string, resource = url.pathname): Promise<boolean> => {
        const allowed = Boolean(principal && authorizer.authorize(principal, action, projectId))
        await auditLog.record({ timestamp: new Date().toISOString(), correlationId, actor: principal?.subject ?? 'anonymous', action, decision: allowed ? 'allowed' : 'denied', projectId, resource })
        if (!allowed) json(res, 403, { error: 'Forbidden.', action, correlationId })
        return allowed
      }
      const requestStartedAt = performance.now()
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('x-frame-options', 'DENY')
      res.setHeader('referrer-policy', 'no-referrer')
      res.once('finish', () => {
        prGuardMetrics.increment('prguard_http_requests_total', { method, route: url.pathname, status: String(res.statusCode) })
        prGuardMetrics.observe('prguard_http_request_duration_ms', performance.now() - requestStartedAt, { method, route: url.pathname })
      })

      if (method === 'GET' && url.pathname === '/metrics') {
        if (!await requireAction('admin:read')) return
        res.statusCode = 200
        res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        res.end(prGuardMetrics.renderPrometheus())
        return
      }

      if (isReady) {
        const sandbox = await sandboxReadiness()
        json(res, sandbox.ready ? 200 : 503, {
          status: sandbox.ready ? 'ready' : 'not_ready',
          service: 'prguard',
          dependencies: {
            queue: options.runtime.prGuardRedisUrl ? 'redis' : 'memory',
            persistence: options.runtime.prGuardMySqlUrl ? 'mysql' : 'file',
            sandbox,
          },
        })
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
        const deliveryIdHeader = req.headers['x-github-delivery']
        const deliveryId = Array.isArray(deliveryIdHeader) ? deliveryIdHeader[0] : deliveryIdHeader
        if (deliveryId) {
          const claimed = await githubDeliveryStore.claim(deliveryId)
          if (!claimed) {
            json(res, 202, { accepted: true, duplicate: true, deliveryId })
            return
          }
        }
        const payload = JSON.parse(body.toString('utf8')) as { action?: string; pull_request?: { head?: { sha?: string } } }
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
          githubSha: payload.pull_request?.head?.sha,
          token: options.runtime.prGuardGithubToken,
        })
        const job = await jobService.create(snapshot, true, { publishFeedback: true, createdBy: systemPrincipal.subject })
        logPrGuardEvent('github_review_job_enqueued', { jobId: job.jobId, githubRef: snapshot.input.githubRef })
        json(res, 202, { accepted: true, jobId: job.jobId, githubRef: snapshot.input.githubRef })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/traces') {
        if (!await requireAction('trace:read')) return
        const traces = (await traceService.list()).filter(trace =>
          Boolean(trace.cwd) && authorizer.authorize(principal!, 'trace:read', projectAuthorizationId(trace.cwd!)),
        )
        json(res, 200, { traces })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/review-jobs') {
        if (!await requireAction('review:read')) return
        const jobs = (await jobService.list()).filter(job => authorizer.authorize(principal!, 'review:read', projectAuthorizationId(job.cwd)))
        json(res, 200, { jobs })
        return
      }

      if (method === 'GET' && url.pathname === '/api/v1/dead-letters') {
        if (!await requireAction('dead-letter:read')) return
        const deadLetters = []
        for (const deadLetter of await jobService.listDeadLetters()) {
          const job = await jobService.get(deadLetter.jobId).catch(() => undefined)
          if (job && authorizer.authorize(principal!, 'dead-letter:read', projectAuthorizationId(job.cwd))) {
            deadLetters.push(deadLetter)
          }
        }
        json(res, 200, { deadLetters })
        return
      }

      const deadLetterMatch = url.pathname.match(/^\/api\/v1\/dead-letters\/([^/]+)\/redrive$/)
      if (method === 'POST' && deadLetterMatch) {
        const deadLetterId = decodeURIComponent(deadLetterMatch[1])
        const deadLetter = (await jobService.listDeadLetters(1000)).find(item => item.id === deadLetterId)
        if (!deadLetter) {
          json(res, 404, { error: 'Dead letter not found.', correlationId })
          return
        }
        const deadLetterJob = await jobService.get(deadLetter.jobId)
        if (!await requireAction('dead-letter:redrive', projectAuthorizationId(deadLetterJob.cwd), deadLetterId)) return
        const job = await jobService.redriveDeadLetter(deadLetterId)
        json(res, 200, { status: 'queued', job })
        return
      }

      const jobMatch = url.pathname.match(/^\/api\/v1\/review-jobs\/([^/]+)$/)
      if (method === 'GET' && jobMatch) {
        const job = await jobService.get(jobMatch[1])
        if (!await requireAction('review:read', projectAuthorizationId(job.cwd), job.jobId)) return
        json(res, 200, job)
        return
      }

      const repairMatch = url.pathname.match(/^\/api\/v1\/review-jobs\/([^/]+)\/repair$/)
      if (method === 'POST' && repairMatch) {
        const body = await readJson(req)
        const job = await jobService.get(repairMatch[1])
        const projectId = projectAuthorizationId(job.cwd)
        if (!await requireAction('repair:generate', projectId, job.jobId)) return
        if (!await requireAction('memory:write', projectId, job.jobId)) return
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
        if (apply && !await requireAction('repair:approve', projectId, job.jobId)) return
        if (apply && !await requireAction('repair:apply', projectId, job.jobId)) return
        if (apply && !await requireAction('memory:feedback', projectId, job.jobId)) return
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

          await trace.record('approval', {
            approved: true,
            source: 'api_request',
            findingIds,
            actor: principal?.subject,
            correlationId,
            projectId,
          })
          await repairService.recordFindingDecisions(
            snapshot.input.cwd,
            job.result,
            findingIds,
            'accepted',
            'Patch application approved through the PRGuard API.',
          )
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
        if (!await requireAction('trace:read')) return
        const events = await traceService.load(traceMatch[1])
        const started = events.find(event => event.type === 'run_started')
        const input = started?.payload.input
        const cwd = input && typeof input === 'object' && !Array.isArray(input)
          ? String((input as Record<string, unknown>).cwd ?? '')
          : ''
        if (!cwd || !await requireAction('trace:read', projectAuthorizationId(cwd), traceMatch[1])) return
        json(res, 200, { runId: traceMatch[1], events })
        return
      }

      if (method === 'POST' && url.pathname === '/api/v1/reviews') {
        const body = await readJson(req)
        const projectId = projectAuthorizationId(String(body.cwd ?? ''))
        if (!await requireAction('review:create', projectId)) return
        if (!await requireAction('memory:read', projectId) || !await requireAction('memory:write', projectId)) return
        const snapshot = await loadPrDiffSnapshot(body)
        const multiAgent = body.multiAgent === true
        const trace = await traceService.create(snapshot.input)
        try {
          const review = await reviewService.review(snapshot, { multiAgent, trace })
          await trace.record('run_finished', { status: 'review_completed' })
          await trace.flush()
          prGuardMetrics.recordTrace(await traceService.load(trace.runId))
          logPrGuardEvent('review_completed', { runId: trace.runId, findingCount: review.findings.length, multiAgent, correlationId, actor: principal?.subject, projectId })
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
        const projectId = projectAuthorizationId(String(body.cwd ?? ''))
        if (!await requireAction('review:create', projectId)) return
        if (!await requireAction('memory:read', projectId) || !await requireAction('memory:write', projectId)) return
        const publishFeedback = body.publishFeedback === true
        if (publishFeedback && !await requireAction('review:publish', projectId)) return
        const snapshot = await loadPrDiffSnapshot(body)
        const job = await jobService.create(snapshot, body.multiAgent === true, { publishFeedback, createdBy: principal?.subject })
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
    void rateLimiter.close()
  })
  return server
}

function bearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : ''
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
