import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { MINI_CODE_DIR } from '../config.js'
import type { ReviewJob } from './jobs.js'

export type ReviewJobRepository = {
  create(job: ReviewJob): Promise<void>
  get(jobId: string): Promise<ReviewJob>
  claim(jobId: string, updatedAt: string, staleAfterMs: number): Promise<ReviewJob | null>
  list(): Promise<ReviewJob[]>
  update(job: ReviewJob): Promise<void>
  touch(jobId: string, updatedAt: string): Promise<void>
}

function validateJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid PRGuard job ID: ${jobId}`)
}

export class FileReviewJobRepository implements ReviewJobRepository {
  constructor(private readonly baseDir = path.join(MINI_CODE_DIR, 'prguard', 'jobs')) {}

  private filePath(jobId: string): string {
    validateJobId(jobId)
    return path.join(this.baseDir, `${jobId}.json`)
  }

  async create(job: ReviewJob): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await this.write(job)
  }

  async get(jobId: string): Promise<ReviewJob> {
    return JSON.parse(await readFile(this.filePath(jobId), 'utf8')) as ReviewJob
  }

  async claim(jobId: string, updatedAt: string, staleAfterMs: number): Promise<ReviewJob | null> {
    const job = await this.get(jobId)
    const staleBefore = Date.parse(updatedAt) - staleAfterMs
    const staleRunning = job.status === 'running' && Date.parse(job.updatedAt) <= staleBefore
    if (job.status !== 'queued' && !staleRunning) return null
    const claimed = { ...job, status: 'running' as const, attempts: job.attempts + 1, updatedAt }
    await this.write(claimed)
    return claimed
  }

  async list(): Promise<ReviewJob[]> {
    try {
      const entries = await readdir(this.baseDir)
      const jobs: ReviewJob[] = []
      for (const entry of entries.filter(item => item.endsWith('.json'))) {
        try {
          jobs.push(JSON.parse(await readFile(path.join(this.baseDir, entry), 'utf8')) as ReviewJob)
        } catch {
          // Ignore partially written or unrelated files.
        }
      }
      return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    } catch {
      return []
    }
  }

  async update(job: ReviewJob): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await this.write(job)
  }

  async touch(jobId: string, updatedAt: string): Promise<void> {
    const job = await this.get(jobId)
    await this.write({ ...job, updatedAt })
  }

  private async write(job: ReviewJob): Promise<void> {
    await writeFile(this.filePath(job.jobId), `${JSON.stringify(job, null, 2)}\n`, 'utf8')
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
        (id, status, multi_agent, cwd, input_json, attempts, max_attempts, run_id, result_json, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.jobId, job.status, job.multiAgent, job.cwd, JSON.stringify(job.input), job.attempts, job.maxAttempts,
        job.runId ?? null,
        job.result ? JSON.stringify(job.result) : null, job.error ?? null,
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

  async claim(jobId: string, updatedAt: string, staleAfterMs: number): Promise<ReviewJob | null> {
    validateJobId(jobId)
    await this.ensureSchema()
    const [result] = await this.pool.execute<import('mysql2/promise').ResultSetHeader>(
      `UPDATE review_jobs
       SET status = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = ?
         AND (status = 'queued' OR (status = 'running' AND updated_at <= ?))`,
      [toMySqlDateTime(updatedAt), jobId, toMySqlDateTime(new Date(Date.parse(updatedAt) - staleAfterMs).toISOString())],
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

  async update(job: ReviewJob): Promise<void> {
    await this.ensureSchema()
    await this.pool.execute(
      `UPDATE review_jobs
       SET status = ?, multi_agent = ?, cwd = ?, attempts = ?, max_attempts = ?, run_id = ?, result_json = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      [job.status, job.multiAgent, job.cwd, job.attempts, job.maxAttempts, job.runId ?? null,
        job.result ? JSON.stringify(job.result) : null, job.error ?? null,
        toMySqlDateTime(job.updatedAt), job.jobId],
    )
  }

  async touch(jobId: string, updatedAt: string): Promise<void> {
    validateJobId(jobId)
    await this.ensureSchema()
    await this.pool.execute(
      'UPDATE review_jobs SET updated_at = ? WHERE id = ?',
      [toMySqlDateTime(updatedAt), jobId],
    )
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
             AND COLUMN_NAME IN ('attempts', 'max_attempts')`,
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
    runId: row.run_id ? String(row.run_id) : undefined,
    result: row.result_json ? typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json : undefined,
    error: row.error_message ? String(row.error_message) : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function toMySqlDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`)
  return date.toISOString().replace('T', ' ').replace('Z', '')
}
