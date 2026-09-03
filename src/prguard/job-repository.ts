import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { MINI_CODE_DIR } from '../config.js'
import type { ReviewJob } from './jobs.js'
import { assertReviewJobTransition, isTerminalReviewJobStatus } from './job-state.js'

export type JobLease = {
  owner: string
  fencingToken: number
}

export type ReviewJobRepository = {
  create(job: ReviewJob): Promise<void>
  get(jobId: string): Promise<ReviewJob>
  claim(jobId: string, leaseOwner: string, claimedAt: string, leaseDurationMs: number): Promise<ReviewJob | null>
  list(): Promise<ReviewJob[]>
  update(job: ReviewJob, lease?: JobLease, expectedUpdatedAt?: string): Promise<boolean>
  heartbeat(jobId: string, lease: JobLease, heartbeatAt: string, leaseDurationMs: number): Promise<boolean>
}

function validateJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid PRGuard job ID: ${jobId}`)
}

function leaseExpiry(startedAt: string, leaseDurationMs: number): string {
  const timestamp = Date.parse(startedAt)
  if (!Number.isFinite(timestamp) || !Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('A valid lease timestamp and positive duration are required.')
  }
  return new Date(timestamp + leaseDurationMs).toISOString()
}

function holdsLease(job: ReviewJob, lease: JobLease, operationAt: string): boolean {
  return job.status === 'running'
    && job.leaseOwner === lease.owner
    && job.fencingToken === lease.fencingToken
    && Boolean(job.leaseExpiresAt && job.leaseExpiresAt > operationAt)
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

export class FileReviewJobRepository implements ReviewJobRepository {
  constructor(private readonly baseDir = path.join(MINI_CODE_DIR, 'prguard', 'jobs')) {}

  private filePath(jobId: string): string {
    validateJobId(jobId)
    return path.join(this.baseDir, `${jobId}.json`)
  }

  private lockPath(jobId: string): string {
    return `${this.filePath(jobId)}.lock`
  }

  async create(job: ReviewJob): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await this.writeAtomic(job)
  }

  async get(jobId: string): Promise<ReviewJob> {
    return normalizeFileJob(JSON.parse(await readFile(this.filePath(jobId), 'utf8')) as ReviewJob)
  }

  async claim(jobId: string, leaseOwner: string, claimedAt: string, leaseDurationMs: number): Promise<ReviewJob | null> {
    return this.withLock(jobId, null, async () => {
      const job = await this.get(jobId)
      const expiredRunning = job.status === 'running'
        && (!job.leaseExpiresAt || job.leaseExpiresAt <= claimedAt)
      if ((job.status !== 'queued' && !expiredRunning) || job.attempts >= job.maxAttempts) return null
      if (job.status === 'queued') assertReviewJobTransition(job.status, 'running')
      const claimed: ReviewJob = {
        ...job,
        status: 'running',
        attempts: job.attempts + 1,
        updatedAt: claimedAt,
        leaseOwner,
        leaseExpiresAt: leaseExpiry(claimedAt, leaseDurationMs),
        fencingToken: (job.fencingToken ?? 0) + 1,
      }
      await this.writeAtomic(claimed)
      return claimed
    })
  }

  async list(): Promise<ReviewJob[]> {
    try {
      const entries = await readdir(this.baseDir)
      const jobs: ReviewJob[] = []
      for (const entry of entries.filter(item => item.endsWith('.json'))) {
        try {
          jobs.push(normalizeFileJob(JSON.parse(await readFile(path.join(this.baseDir, entry), 'utf8')) as ReviewJob))
        } catch {
          // Ignore partially written or unrelated files.
        }
      }
      return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    } catch {
      return []
    }
  }

  async update(job: ReviewJob, lease?: JobLease, expectedUpdatedAt?: string): Promise<boolean> {
    return this.withLock(job.jobId, false, async () => {
      const current = await this.get(job.jobId)
      if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) return false
      if (lease && !holdsLease(current, lease, job.updatedAt)) return false
      if (current.status !== job.status) assertReviewJobTransition(current.status, job.status)
      const updated = isTerminalReviewJobStatus(job.status) || job.status === 'queued'
        ? { ...job, leaseOwner: undefined, leaseExpiresAt: undefined }
        : job
      await this.writeAtomic(updated)
      return true
    })
  }

  async heartbeat(jobId: string, lease: JobLease, heartbeatAt: string, leaseDurationMs: number): Promise<boolean> {
    return this.withLock(jobId, false, async () => {
      const job = await this.get(jobId)
      if (!holdsLease(job, lease, heartbeatAt)) return false
      await this.writeAtomic({
        ...job,
        updatedAt: heartbeatAt,
        leaseExpiresAt: leaseExpiry(heartbeatAt, leaseDurationMs),
      })
      return true
    })
  }

  private async writeAtomic(job: ReviewJob): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    const target = this.filePath(job.jobId)
    const temporary = path.join(this.baseDir, `.${job.jobId}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private async withLock<T>(jobId: string, busyValue: T, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.baseDir, { recursive: true })
    const lockPath = this.lockPath(jobId)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        handle = await open(lockPath, 'wx')
        break
      } catch (error) {
        if (!isFileExistsError(error)) throw error
        try {
          const lockStat = await stat(lockPath)
          if (Date.now() - lockStat.mtimeMs > 30_000) {
            await unlink(lockPath)
            continue
          }
        } catch {
          continue
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    if (!handle) return busyValue
    try {
      return await operation()
    } finally {
      await handle.close()
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

export class MySqlReviewJobRepository implements ReviewJobRepository {
  private readonly pool: import('mysql2/promise').Pool
  private initialized: Promise<void> | undefined

  constructor(connectionString: string) {
    this.pool = mysql.createPool({
      uri: connectionString,
      connectionLimit: 5,
      charset: 'utf8mb4',
    })
  }

  async create(job: ReviewJob): Promise<void> {
    await this.ensureSchema()
    await this.pool.execute(
      `INSERT INTO review_jobs
        (id, status, multi_agent, cwd, input_json, attempts, max_attempts, fencing_token,
         lease_owner, lease_expires_at, run_id, result_json, error_message, github_feedback_published_at,
         publish_feedback, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.jobId, job.status, job.multiAgent, job.cwd, JSON.stringify(job.input), job.attempts, job.maxAttempts,
        job.fencingToken, job.leaseOwner ?? null, job.leaseExpiresAt ? toMySqlDateTime(job.leaseExpiresAt) : null, job.runId ?? null,
        job.result ? JSON.stringify(job.result) : null, job.error ?? null,
        job.githubFeedbackPublishedAt ? toMySqlDateTime(job.githubFeedbackPublishedAt) : null,
        job.publishFeedback === true, job.createdBy ?? null,
        toMySqlDateTime(job.createdAt), toMySqlDateTime(job.updatedAt)],
    )
  }

  async get(jobId: string): Promise<ReviewJob> {
    validateJobId(jobId)
    await this.ensureSchema()
    const [rows] = await this.pool.execute<import('mysql2/promise').RowDataPacket[]>(
      'SELECT * FROM review_jobs WHERE id = ?', [jobId],
    )
    const row = rows[0]
    if (!row) throw new Error(`PRGuard job not found: ${jobId}`)
    return fromRow(row)
  }

  async claim(jobId: string, leaseOwner: string, claimedAt: string, leaseDurationMs: number): Promise<ReviewJob | null> {
    validateJobId(jobId)
    await this.ensureSchema()
    const [result] = await this.pool.execute<import('mysql2/promise').ResultSetHeader>(
      `UPDATE review_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = ?, lease_owner = ?,
           lease_expires_at = ?, fencing_token = fencing_token + 1
       WHERE id = ?
         AND attempts < max_attempts
         AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`,
      [toMySqlDateTime(claimedAt), leaseOwner, toMySqlDateTime(leaseExpiry(claimedAt, leaseDurationMs)),
        jobId, toMySqlDateTime(claimedAt)],
    )
    if (result.affectedRows === 0) return null
    return this.get(jobId)
  }

  async list(): Promise<ReviewJob[]> {
    await this.ensureSchema()
    const [rows] = await this.pool.query<import('mysql2/promise').RowDataPacket[]>(
      'SELECT * FROM review_jobs ORDER BY created_at DESC',
    )
    return rows.map(fromRow)
  }

  async update(job: ReviewJob, lease?: JobLease, expectedUpdatedAt?: string): Promise<boolean> {
    await this.ensureSchema()
    const current = await this.get(job.jobId)
    if (lease && !holdsLease(current, lease, job.updatedAt)) return false
    if (current.status !== job.status) assertReviewJobTransition(current.status, job.status)
    const clearLease = isTerminalReviewJobStatus(job.status) || job.status === 'queued'
    const params: unknown[] = [job.status, job.multiAgent, job.cwd, job.attempts, job.maxAttempts,
      job.fencingToken, clearLease ? null : job.leaseOwner ?? null,
      clearLease || !job.leaseExpiresAt ? null : toMySqlDateTime(job.leaseExpiresAt),
      job.runId ?? null, job.result ? JSON.stringify(job.result) : null, job.error ?? null,
      job.githubFeedbackPublishedAt ? toMySqlDateTime(job.githubFeedbackPublishedAt) : null,
      job.publishFeedback === true, job.createdBy ?? null,
      toMySqlDateTime(job.updatedAt), job.jobId, current.status]
    let where = 'WHERE id = ? AND status = ?'
    if (expectedUpdatedAt) {
      where += ' AND updated_at = ?'
      params.push(toMySqlDateTime(expectedUpdatedAt))
    }
    if (lease) {
      where += ' AND status = \'running\' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > ?'
      params.push(lease.owner, lease.fencingToken, toMySqlDateTime(job.updatedAt))
    }
    const [result] = await this.pool.execute<import('mysql2/promise').ResultSetHeader>(
      `UPDATE review_jobs
       SET status = ?, multi_agent = ?, cwd = ?, attempts = ?, max_attempts = ?, fencing_token = ?,
           lease_owner = ?, lease_expires_at = ?, run_id = ?, result_json = ?, error_message = ?,
           github_feedback_published_at = ?, publish_feedback = ?, created_by = ?, updated_at = ?
       ${where}`,
      params,
    )
    return result.affectedRows === 1
  }

  async heartbeat(jobId: string, lease: JobLease, heartbeatAt: string, leaseDurationMs: number): Promise<boolean> {
    validateJobId(jobId)
    await this.ensureSchema()
    const [result] = await this.pool.execute<import('mysql2/promise').ResultSetHeader>(
      `UPDATE review_jobs SET updated_at = ?, lease_expires_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > ?`,
      [toMySqlDateTime(heartbeatAt), toMySqlDateTime(leaseExpiry(heartbeatAt, leaseDurationMs)),
        jobId, lease.owner, lease.fencingToken, toMySqlDateTime(heartbeatAt)],
    )
    return result.affectedRows === 1
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async ensureSchema(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.pool.execute(`
        CREATE TABLE IF NOT EXISTS review_jobs (
          id VARCHAR(64) PRIMARY KEY,
          status VARCHAR(16) NOT NULL,
          multi_agent BOOLEAN NOT NULL DEFAULT FALSE,
          cwd TEXT NOT NULL,
          input_json JSON NOT NULL,
          attempts INT UNSIGNED NOT NULL DEFAULT 0,
          max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
          fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
          lease_owner VARCHAR(128) NULL,
          lease_expires_at DATETIME(3) NULL,
          github_feedback_published_at DATETIME(3) NULL,
          publish_feedback BOOLEAN NOT NULL DEFAULT FALSE,
          created_by VARCHAR(191) NULL,
          run_id VARCHAR(64) NULL,
          result_json JSON NULL,
          error_message TEXT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          INDEX idx_review_jobs_status_created (status, created_at),
          INDEX idx_review_jobs_run_id (run_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `).then(async () => {
        // MySQL 8.4 does not support `ADD COLUMN IF NOT EXISTS` (MariaDB does).
        // Check INFORMATION_SCHEMA first so existing installations can migrate safely.
        const [columns] = await this.pool.query<import('mysql2/promise').RowDataPacket[]>(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_jobs'
             AND COLUMN_NAME IN ('attempts', 'max_attempts', 'fencing_token', 'lease_owner', 'lease_expires_at', 'github_feedback_published_at', 'publish_feedback', 'created_by')`,
        )
        const existing = new Set(columns.map(column => String(column.COLUMN_NAME)))
        if (!existing.has('attempts')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0',
          )
        }
        if (!existing.has('max_attempts')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN max_attempts INT UNSIGNED NOT NULL DEFAULT 3',
          )
        }
        if (!existing.has('fencing_token')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0',
          )
        }
        if (!existing.has('lease_owner')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN lease_owner VARCHAR(128) NULL',
          )
        }
        if (!existing.has('lease_expires_at')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN lease_expires_at DATETIME(3) NULL',
          )
        }
        if (!existing.has('github_feedback_published_at')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN github_feedback_published_at DATETIME(3) NULL',
          )
        }
        if (!existing.has('publish_feedback')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN publish_feedback BOOLEAN NOT NULL DEFAULT FALSE',
          )
        }
        if (!existing.has('created_by')) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD COLUMN created_by VARCHAR(191) NULL',
          )
        }
        const [indexes] = await this.pool.query<import('mysql2/promise').RowDataPacket[]>(
          `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'review_jobs'
             AND INDEX_NAME = 'idx_review_jobs_lease_expiry'`,
        )
        if (indexes.length === 0) {
          await this.pool.execute(
            'ALTER TABLE review_jobs ADD INDEX idx_review_jobs_lease_expiry (status, lease_expires_at)',
          )
        }
      })
    }
    await this.initialized
  }
}

export function createDefaultReviewJobRepository(
  fileBaseDir?: string,
  connectionString?: string,
): ReviewJobRepository {
  const configuredConnectionString = connectionString?.trim() || process.env.PR_GUARD_MYSQL_URL?.trim()
  if (configuredConnectionString) return new MySqlReviewJobRepository(configuredConnectionString)
  return new FileReviewJobRepository(fileBaseDir)
}

function fromRow(row: import('mysql2/promise').RowDataPacket): ReviewJob {
  return {
    jobId: String(row.id),
    status: row.status as ReviewJob['status'],
    multiAgent: Boolean(row.multi_agent),
    cwd: String(row.cwd),
    input: typeof row.input_json === 'string' ? JSON.parse(row.input_json) : row.input_json,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    fencingToken: Number(row.fencing_token ?? 0),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : undefined,
    runId: row.run_id ? String(row.run_id) : undefined,
    result: row.result_json ? typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json : undefined,
    error: row.error_message ? String(row.error_message) : undefined,
    githubFeedbackPublishedAt: row.github_feedback_published_at ? new Date(row.github_feedback_published_at).toISOString() : undefined,
    publishFeedback: Boolean(row.publish_feedback),
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function normalizeFileJob(job: ReviewJob): ReviewJob {
  return { ...job, fencingToken: job.fencingToken ?? 0 }
}

function toMySqlDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`)
  return date.toISOString().replace('T', ' ').replace('Z', '')
}
