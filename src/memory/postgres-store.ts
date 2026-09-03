import pg from 'pg'
import { createId } from '../runtime/ids.js'
import type { LongTermMemoryItem, MemorySearchQuery, MemoryStore } from './types.js'
import { defaultMemoryTrust, redactMemoryContent } from './safety.js'

const { Pool } = pg

type MemoryInput = Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }

function vectorLiteral(vector: number[] | undefined): string | null {
  if (!vector) return null
  if (vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
    throw new Error('Memory embedding must contain finite numbers.')
  }
  return `[${vector.join(',')}]`
}

function fromRow(row: Record<string, unknown>): LongTermMemoryItem {
  return {
    id: String(row.id),
    kind: row.kind as LongTermMemoryItem['kind'],
    projectId: String(row.project_id),
    content: String(row.content),
    source: row.source as LongTermMemoryItem['source'],
    category: row.category ? String(row.category) : undefined,
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
    confidence: Number(row.confidence),
    status: row.status as LongTermMemoryItem['status'],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : undefined,
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : undefined,
    usageCount: Number(row.usage_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    provenance: row.provenance as LongTermMemoryItem['provenance'],
    metadata: row.metadata as Record<string, unknown> | undefined,
    embeddingStatus: row.embedding_status as LongTermMemoryItem['embeddingStatus'],
    embeddingAttempts: Number(row.embedding_attempts ?? 0),
    embeddingLastError: row.embedding_last_error ? String(row.embedding_last_error) : undefined,
    trustLevel: row.trust_level as LongTermMemoryItem['trustLevel'],
    embeddingModel: row.embedding_model ? String(row.embedding_model) : undefined,
    embeddingDimensions: row.embedding_dimensions ? Number(row.embedding_dimensions) : undefined,
    schemaVersion: Number(row.schema_version ?? 1),
  }
}

export class PostgresLongTermMemoryStore implements MemoryStore {
  readonly kind: LongTermMemoryItem['kind']

  constructor(
    kind: LongTermMemoryItem['kind'],
    connectionString = process.env.PR_GUARD_POSTGRES_URL,
    private readonly pool = connectionString ? new Pool({ connectionString, max: 10 }) : undefined,
    private readonly embed?: (text: string) => Promise<number[]>,
    private readonly embeddingInfo: { model?: string; dimensions?: number } = {},
  ) {
    if (!this.pool) throw new Error('PR_GUARD_POSTGRES_URL is required for PostgreSQL memory.')
    this.kind = kind
  }

  async save(input: MemoryInput): Promise<LongTermMemoryItem> {
    if (!input.content.trim()) throw new Error('Long-term memory content cannot be empty.')
    if (input.confidence < 0 || input.confidence > 1) throw new Error('Memory confidence must be between 0 and 1.')
    const now = input.updatedAt ?? input.createdAt
    const safeContent = redactMemoryContent(input.content.trim())
    const record: LongTermMemoryItem = {
      ...input,
      content: redactMemoryContent(input.content.trim()),
      id: input.id ?? createId('memory'),
      kind: this.kind,
      tags: [...new Set(input.tags)],
      status: input.status ?? 'active',
      updatedAt: now,
      usageCount: input.usageCount ?? 0,
      successCount: input.successCount ?? 0,
      failureCount: input.failureCount ?? 0,
      trustLevel: input.trustLevel ?? defaultMemoryTrust(input.source, safeContent),
      schemaVersion: input.schemaVersion ?? 1,
    }
    let embedding: string | null = null
    let embeddingStatus: NonNullable<LongTermMemoryItem['embeddingStatus']> = this.embed ? 'pending' : 'ready'
    let embeddingError: string | null = null
    if (this.embed) {
      try {
        embedding = vectorLiteral(await this.embed(record.content))
        embeddingStatus = 'ready'
      } catch (error) {
        embeddingStatus = 'failed'
        embeddingError = error instanceof Error ? error.message : String(error)
      }
    }
    await this.pool!.query(
      `INSERT INTO memories
        (id, project_id, kind, content, source, category, tags, confidence, status,
         usage_count, success_count, failure_count, created_at, updated_at, last_used_at,
         expires_at, provenance, metadata, embedding, embedding_status, embedding_attempts, embedding_last_error,
         trust_level, embedding_model, embedding_dimensions, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::vector,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (id) DO UPDATE SET
         content=EXCLUDED.content, category=EXCLUDED.category, tags=EXCLUDED.tags,
         confidence=EXCLUDED.confidence, status=EXCLUDED.status,
         usage_count=EXCLUDED.usage_count, success_count=EXCLUDED.success_count,
         failure_count=EXCLUDED.failure_count, updated_at=EXCLUDED.updated_at,
         last_used_at=EXCLUDED.last_used_at, expires_at=EXCLUDED.expires_at,
         provenance=EXCLUDED.provenance, metadata=EXCLUDED.metadata,
         embedding=COALESCE(EXCLUDED.embedding, memories.embedding),
         embedding_status=EXCLUDED.embedding_status,
         embedding_attempts=EXCLUDED.embedding_attempts,
         embedding_last_error=EXCLUDED.embedding_last_error,
         trust_level=EXCLUDED.trust_level,
         embedding_model=EXCLUDED.embedding_model,
         embedding_dimensions=EXCLUDED.embedding_dimensions,
         schema_version=EXCLUDED.schema_version`,
      [record.id, record.projectId, record.kind, record.content, record.source, record.category ?? null,
        JSON.stringify(record.tags), record.confidence, record.status, record.usageCount, record.successCount,
        record.failureCount, record.createdAt, record.updatedAt, record.lastUsedAt ?? null, record.expiresAt ?? null,
        JSON.stringify(record.provenance ?? null), JSON.stringify(record.metadata ?? null), embedding,
        embeddingStatus, 0, embeddingError, record.trustLevel, input.embeddingModel ?? this.embeddingInfo.model ?? null,
        input.embeddingDimensions ?? this.embeddingInfo.dimensions ?? null, record.schemaVersion],
    )
    if (embeddingStatus !== 'ready' && this.embed) {
      await this.pool!.query(
        `INSERT INTO memory_embedding_outbox (memory_id, project_id, attempts, status, next_attempt_at, last_error)
         VALUES ($1,$2,0,'pending',NOW(),$3)
         ON CONFLICT (memory_id) DO UPDATE SET status='pending', next_attempt_at=NOW(), last_error=EXCLUDED.last_error, updated_at=NOW()`,
        [record.id, record.projectId, embeddingError],
      )
    }
    const conflictKey = ['conflictKey', 'findingKey', 'factKey']
      .map(key => record.metadata?.[key])
      .find(value => typeof value === 'string' && value.trim())
    if (typeof conflictKey === 'string') {
      await this.pool!.query(
        `UPDATE memories
         SET status='superseded', updated_at=$1
         WHERE project_id=$2 AND id<>$3 AND status='active'
           AND COALESCE(metadata->>'conflictKey', metadata->>'findingKey', metadata->>'factKey')=$4`,
        [record.updatedAt, record.projectId, record.id, conflictKey],
      )
    }
    await this.audit(record.projectId, record.id, 'write', { embeddingStatus })
    return record
  }

  private async audit(projectId: string, memoryId: string | null, action: 'write' | 'retrieve' | 'archive' | 'reinforce' | 'embedding_retry', metadata: Record<string, unknown> = {}): Promise<void> {
    await this.pool!.query(
      `INSERT INTO memory_access_audit (memory_id, project_id, kind, action, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [memoryId, projectId, this.kind, action, JSON.stringify(metadata)],
    )
  }

  remember(input: MemoryInput): Promise<LongTermMemoryItem> {
    return this.save(input)
  }

  async list(projectId: string, now = new Date().toISOString()): Promise<LongTermMemoryItem[]> {
    const result = await this.pool!.query(
      `SELECT * FROM memories
       WHERE project_id=$1 AND kind=$2 AND status NOT IN ('archived','superseded')
         AND (expires_at IS NULL OR expires_at > $3)
       ORDER BY COALESCE(updated_at, created_at) DESC`,
      [projectId, this.kind, now],
    )
    return result.rows.map(fromRow)
  }

  async getByIds(projectId: string, ids: string[]): Promise<LongTermMemoryItem[]> {
    if (ids.length === 0) return []
    const result = await this.pool!.query(
      `SELECT * FROM memories WHERE project_id=$1 AND kind=$2 AND id = ANY($3::text[])`,
      [projectId, this.kind, ids],
    )
    return result.rows.map(fromRow)
  }

  async search(query: MemorySearchQuery): Promise<LongTermMemoryItem[]> {
    const items = await this.list(query.projectId, query.now)
    const text = (query.text ?? '').toLowerCase()
    return items.filter(item => !text || `${item.content} ${item.category ?? ''} ${item.tags.join(' ')}`.toLowerCase().includes(text)).slice(0, query.limit ?? 10)
  }

  async searchVector(query: MemorySearchQuery, vector: number[]): Promise<Array<{ id: string; score: number }>> {
    const result = await this.pool!.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS score
       FROM memories
       WHERE project_id=$2 AND kind=$3 AND status='active'
         AND embedding IS NOT NULL AND embedding_status='ready'
         AND ($4::text IS NULL OR category=$4)
         AND (expires_at IS NULL OR expires_at > COALESCE($5::timestamptz, NOW()))
       ORDER BY embedding <=> $1::vector
       LIMIT $6`,
      [vectorLiteral(vector), query.projectId, this.kind, query.category ?? null, query.now ?? null, Math.max(20, query.limit ?? 10)],
    )
    await this.audit(query.projectId, null, 'retrieve', { limit: query.limit ?? 10, semantic: true })
    return result.rows.map(row => ({ id: String(row.id), score: Number(row.score) }))
  }

  async retryFailedEmbeddings(limit = 10): Promise<{ completed: number; failed: number }> {
    if (!this.embed) return { completed: 0, failed: 0 }
    const pending = await this.pool!.query(
      `WITH candidates AS (
         SELECT memory_id FROM memory_embedding_outbox
           WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
             AND EXISTS (SELECT 1 FROM memories m WHERE m.id=memory_embedding_outbox.memory_id AND m.kind=$1)
           ORDER BY next_attempt_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE memory_embedding_outbox AS outbox
       SET status='processing', updated_at=NOW()
       FROM candidates
       WHERE outbox.memory_id=candidates.memory_id
       RETURNING outbox.memory_id, outbox.attempts`,
      [this.kind, limit],
    )
    let completed = 0
    let failed = 0
    for (const row of pending.rows) {
      const memory = await this.pool!.query(
        `SELECT * FROM memories WHERE id=$1 AND kind=$2 AND status='active'`,
        [String(row.memory_id), this.kind],
      )
      if (!memory.rows[0]) {
        await this.pool!.query(
          `UPDATE memory_embedding_outbox SET status='completed', updated_at=NOW() WHERE memory_id=$1`,
          [String(row.memory_id)],
        )
        continue
      }
      const attempts = Number(row.attempts ?? 0) + 1
      try {
        const vector = vectorLiteral(await this.embed(String(memory.rows[0].content)))
        await this.pool!.query(
          `UPDATE memories SET embedding=$1::vector, embedding_status='ready', embedding_attempts=$2, embedding_last_error=NULL, updated_at=NOW() WHERE id=$3`,
          [vector, attempts, String(row.memory_id)],
        )
        await this.pool!.query(
          `UPDATE memory_embedding_outbox SET status='completed', attempts=$1, updated_at=NOW() WHERE memory_id=$2`,
          [attempts, String(row.memory_id)],
        )
        await this.audit(String(memory.rows[0].project_id), String(row.memory_id), 'embedding_retry', { status: 'completed', attempts })
        completed += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10))
        await this.pool!.query(
          `UPDATE memories SET embedding_status='failed', embedding_attempts=$1, embedding_last_error=$2, updated_at=NOW() WHERE id=$3`,
          [attempts, message, String(row.memory_id)],
        )
        await this.pool!.query(
          `UPDATE memory_embedding_outbox SET status='failed', attempts=$1, last_error=$2, next_attempt_at=NOW() + ($3 || ' seconds')::interval, updated_at=NOW() WHERE memory_id=$4`,
          [attempts, message, delaySeconds, String(row.memory_id)],
        )
        await this.audit(String(memory.rows[0].project_id), String(row.memory_id), 'embedding_retry', { status: 'failed', attempts, error: message })
        failed += 1
      }
    }
    return { completed, failed }
  }

  async archive(projectId: string, id: string, archivedAt = new Date().toISOString()): Promise<boolean> {
    const result = await this.pool!.query(
      `UPDATE memories SET status='archived', expires_at=$1, updated_at=$1
       WHERE id=$2 AND project_id=$3 AND kind=$4 AND status NOT IN ('archived','superseded')`,
      [archivedAt, id, projectId, this.kind],
    )
    if (result.rowCount === 1) await this.audit(projectId, id, 'archive')
    return result.rowCount === 1
  }

  async reinforce(projectId: string, id: string, outcome: 'used' | 'successful' | 'failed', now = new Date().toISOString()): Promise<LongTermMemoryItem | null> {
    const delta = outcome === 'successful' ? 0.03 : outcome === 'failed' ? -0.05 : 0
    const result = await this.pool!.query(
      `UPDATE memories SET
         usage_count = usage_count + CASE WHEN $1='used' THEN 1 ELSE 0 END,
         success_count = success_count + CASE WHEN $1='successful' THEN 1 ELSE 0 END,
         failure_count = failure_count + CASE WHEN $1='failed' THEN 1 ELSE 0 END,
         confidence = GREATEST(0, LEAST(1, confidence + $2)),
         last_used_at=$3, updated_at=$3
       WHERE id=$4 AND project_id=$5 AND kind=$6 AND status='active'
       RETURNING *`,
      [outcome, delta, now, id, projectId, this.kind],
    )
    if (result.rows[0]) await this.audit(projectId, id, 'reinforce', { outcome })
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  async enforceCapacity(projectId: string, maxItems: number, now = new Date().toISOString()): Promise<string[]> {
    const items = await this.list(projectId, now)
    if (items.length <= maxItems) return []
    const ranked = [...items].sort((a, b) =>
      ((b.confidence * 2) + Math.log1p(b.usageCount ?? 0) + (b.successCount ?? 0) * 0.25 - (b.failureCount ?? 0) * 0.5)
      - ((a.confidence * 2) + Math.log1p(a.usageCount ?? 0) + (a.successCount ?? 0) * 0.25 - (a.failureCount ?? 0) * 0.5),
    )
    const archived: string[] = []
    for (const item of ranked.slice(maxItems)) {
      if (await this.archive(projectId, item.id, now)) archived.push(item.id)
    }
    return archived
  }

  async close(): Promise<void> {
    await this.pool!.end()
  }
}
