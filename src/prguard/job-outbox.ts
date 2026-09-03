import crypto from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { MINI_CODE_DIR } from '../config.js'

export type ReviewJobOutboxEvent = {
  id: string
  jobId: string
  kind: 'enqueue'
  idempotencyKey: string
  availableAt: string
  createdAt: string
  status: 'pending' | 'published'
  publishAttempts: number
  publishedAt?: string
  lastError?: string
  sourceDeadLetterId?: string
}

export type ReviewJobOutbox = {
  schedule(input: Omit<ReviewJobOutboxEvent, 'id' | 'status' | 'publishAttempts'>): Promise<ReviewJobOutboxEvent>
  due(now: string, limit?: number): Promise<ReviewJobOutboxEvent[]>
  markPublished(id: string, publishedAt: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
}

function eventId(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
}

export class FileReviewJobOutbox implements ReviewJobOutbox {
  constructor(private readonly baseDir = path.join(MINI_CODE_DIR, 'prguard', 'outbox')) {}

  async schedule(input: Omit<ReviewJobOutboxEvent, 'id' | 'status' | 'publishAttempts'>): Promise<ReviewJobOutboxEvent> {
    const event: ReviewJobOutboxEvent = { ...input, id: eventId(input.idempotencyKey), status: 'pending', publishAttempts: 0 }
    await mkdir(this.baseDir, { recursive: true })
    try {
      await writeFile(this.filePath(event.id), `${JSON.stringify(event, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return event
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return this.get(event.id)
      throw error
    }
  }

  async due(now: string, limit = 100): Promise<ReviewJobOutboxEvent[]> {
    let entries: string[]
    try { entries = await readdir(this.baseDir) } catch { return [] }
    const events: ReviewJobOutboxEvent[] = []
    for (const entry of entries.filter(item => item.endsWith('.json'))) {
      try {
        const event = JSON.parse(await readFile(path.join(this.baseDir, entry), 'utf8')) as ReviewJobOutboxEvent
        if (event.status === 'pending' && event.availableAt <= now) events.push(event)
      } catch {
        // Ignore partial or unrelated files; atomic writes keep valid events readable.
      }
    }
    return events.sort((a, b) => a.availableAt.localeCompare(b.availableAt)).slice(0, limit)
  }

  async markPublished(id: string, publishedAt: string): Promise<void> {
    const event = await this.get(id)
    await this.write({ ...event, status: 'published', publishedAt, publishAttempts: event.publishAttempts + 1, lastError: undefined })
  }

  async markFailed(id: string, error: string): Promise<void> {
    const event = await this.get(id)
    await this.write({ ...event, publishAttempts: event.publishAttempts + 1, lastError: error })
  }

  private filePath(id: string): string { return path.join(this.baseDir, `${id}.json`) }
  private async get(id: string): Promise<ReviewJobOutboxEvent> {
    return JSON.parse(await readFile(this.filePath(id), 'utf8')) as ReviewJobOutboxEvent
  }
  private async write(event: ReviewJobOutboxEvent): Promise<void> {
    const target = this.filePath(event.id)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(event, null, 2)}\n`, 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

export class MySqlReviewJobOutbox implements ReviewJobOutbox {
  private readonly pool: import('mysql2/promise').Pool
  private initialized?: Promise<void>

  constructor(connectionString: string) {
    this.pool = mysql.createPool({ uri: connectionString, connectionLimit: 5, charset: 'utf8mb4' })
  }

  async schedule(input: Omit<ReviewJobOutboxEvent, 'id' | 'status' | 'publishAttempts'>): Promise<ReviewJobOutboxEvent> {
    await this.ensureSchema()
    const event: ReviewJobOutboxEvent = { ...input, id: eventId(input.idempotencyKey), status: 'pending', publishAttempts: 0 }
    await this.pool.execute(
      `INSERT IGNORE INTO review_job_outbox
       (id, job_id, event_kind, idempotency_key, available_at, created_at, status, publish_attempts, source_dead_letter_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      [event.id, event.jobId, event.kind, event.idempotencyKey, toMySqlDateTime(event.availableAt), toMySqlDateTime(event.createdAt), event.sourceDeadLetterId ?? null],
    )
    const [rows] = await this.pool.execute<import('mysql2/promise').RowDataPacket[]>('SELECT * FROM review_job_outbox WHERE id = ?', [event.id])
    return fromRow(rows[0]!)
  }

  async due(now: string, limit = 100): Promise<ReviewJobOutboxEvent[]> {
    await this.ensureSchema()
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
    const [rows] = await this.pool.query<import('mysql2/promise').RowDataPacket[]>(
      `SELECT * FROM review_job_outbox WHERE status = 'pending' AND available_at <= ? ORDER BY available_at LIMIT ${safeLimit}`,
      [toMySqlDateTime(now)],
    )
    return rows.map(fromRow)
  }

  async markPublished(id: string, publishedAt: string): Promise<void> {
    await this.ensureSchema()
    await this.pool.execute(
      `UPDATE review_job_outbox SET status = 'published', published_at = ?, publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = ?`,
      [toMySqlDateTime(publishedAt), id],
    )
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.ensureSchema()
    await this.pool.execute(
      `UPDATE review_job_outbox SET publish_attempts = publish_attempts + 1, last_error = ? WHERE id = ?`,
      [error, id],
    )
  }

  private async ensureSchema(): Promise<void> {
    this.initialized ??= this.pool.execute(`
      CREATE TABLE IF NOT EXISTS review_job_outbox (
        id CHAR(32) PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL,
        event_kind VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL UNIQUE,
        available_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        status VARCHAR(16) NOT NULL,
        publish_attempts INT UNSIGNED NOT NULL DEFAULT 0,
        published_at DATETIME(3) NULL,
        last_error TEXT NULL,
        source_dead_letter_id VARCHAR(128) NULL,
        INDEX idx_review_job_outbox_due (status, available_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).then(() => undefined)
    await this.initialized
  }
}

export function createDefaultReviewJobOutbox(fileBaseDir?: string, connectionString?: string): ReviewJobOutbox {
  const configured = connectionString?.trim() || process.env.PR_GUARD_MYSQL_URL?.trim()
  return configured
    ? new MySqlReviewJobOutbox(configured)
    : new FileReviewJobOutbox(fileBaseDir ? path.join(fileBaseDir, 'outbox') : undefined)
}

function fromRow(row: import('mysql2/promise').RowDataPacket): ReviewJobOutboxEvent {
  return {
    id: String(row.id), jobId: String(row.job_id), kind: 'enqueue', idempotencyKey: String(row.idempotency_key),
    availableAt: new Date(row.available_at).toISOString(), createdAt: new Date(row.created_at).toISOString(),
    status: row.status, publishAttempts: Number(row.publish_attempts),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    sourceDeadLetterId: row.source_dead_letter_id ? String(row.source_dead_letter_id) : undefined,
  }
}

function toMySqlDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`)
  return date.toISOString().replace('T', ' ').replace('Z', '')
}
