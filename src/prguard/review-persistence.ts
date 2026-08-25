import mysql from 'mysql2/promise'
import type { Patch, PrDiffSnapshot, ReviewResult } from './types.js'
import type { PrGuardTraceEvent } from './trace.js'

export type ReviewPersistence = {
  saveReview(args: { jobId?: string; snapshot: PrDiffSnapshot; result: ReviewResult }): Promise<void>
  savePatch(reviewId: string, patch: Patch): Promise<void>
  saveTrace(events: PrGuardTraceEvent[]): Promise<void>
}

export class NoopReviewPersistence implements ReviewPersistence {
  async saveReview(): Promise<void> {}
  async savePatch(): Promise<void> {}
  async saveTrace(): Promise<void> {}
}

export class MySqlReviewPersistence implements ReviewPersistence {
  private readonly pool: import('mysql2/promise').Pool
  private initialized: Promise<void> | undefined

  constructor(connectionString: string) {
    this.pool = mysql.createPool({ uri: connectionString, connectionLimit: 5, charset: 'utf8mb4' })
  }

  async saveReview(args: { jobId?: string; snapshot: PrDiffSnapshot; result: ReviewResult }): Promise<void> {
    await this.ensureSchema()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute(
        `INSERT INTO reviews
          (id, job_id, review_id, branch_name, finding_count, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          job_id = VALUES(job_id), branch_name = VALUES(branch_name),
          finding_count = VALUES(finding_count), result_json = VALUES(result_json)`,
        [args.result.reviewId, args.jobId ?? null, args.result.reviewId,
          args.snapshot.repository.branch ?? null, args.result.findings.length,
          JSON.stringify(args.result), toMySqlDateTime(args.result.createdAt)],
      )
      await connection.execute('DELETE FROM findings WHERE review_id = ?', [args.result.reviewId])
      for (const finding of args.result.findings) {
        await connection.execute(
          `INSERT INTO findings
            (id, review_id, category, severity, confidence, status, file_path,
             line_start, line_end, title, reason, suggested_fix, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`${args.result.reviewId}:${finding.id}`, args.result.reviewId, finding.category,
            finding.severity, finding.confidence, finding.status, finding.file,
            finding.lineStart, finding.lineEnd, finding.title, finding.reason,
            finding.suggestedFix, JSON.stringify(finding.evidence), toMySqlDateTime(args.result.createdAt)],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async savePatch(reviewId: string, patch: Patch): Promise<void> {
    await this.ensureSchema()
    await this.pool.execute(
      `INSERT INTO patches (review_id, status, summary, unified_diff, finding_ids_json)
       VALUES (?, ?, ?, ?, ?)`,
      [reviewId, patch.status, patch.summary, patch.unifiedDiff, JSON.stringify(patch.findingIds)],
    )
  }

  async saveTrace(events: PrGuardTraceEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.ensureSchema()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      for (const event of events) {
        await connection.execute(
          `INSERT INTO trace_events (run_id, sequence_no, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE event_type = VALUES(event_type), payload_json = VALUES(payload_json), created_at = VALUES(created_at)`,
          [event.runId, event.sequence, event.type, JSON.stringify(event.payload), toMySqlDateTime(event.timestamp)],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async ensureSchema(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.pool.query('SELECT 1').then(() => undefined)
    }
    await this.initialized
  }
}

export function createDefaultReviewPersistence(connectionString?: string): ReviewPersistence {
  const configured = connectionString?.trim() || process.env.PR_GUARD_MYSQL_URL?.trim()
  return configured ? new MySqlReviewPersistence(configured) : new NoopReviewPersistence()
}

function toMySqlDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`)
  return date.toISOString().replace('T', ' ').replace('Z', '')
}
