import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import { createId } from '../runtime/ids.js'
import type { LongTermMemoryItem, MemorySearchQuery, MemoryStore } from './types.js'
import { defaultMemoryTrust, redactMemoryContent } from './safety.js'

function safeProjectId(projectId: string): string {
  const value = projectId.trim()
  if (!value || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid memory project ID: ${projectId}`)
  return value
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/u).filter(Boolean))
}

export class LongTermMemoryStore implements MemoryStore {
  readonly kind: LongTermMemoryItem['kind']

  constructor(
    kind: LongTermMemoryItem['kind'],
    private readonly baseDir = path.join(MINI_CODE_DIR, 'runtime', 'long-term-memory'),
  ) { this.kind = kind }

  remember(item: Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }): Promise<LongTermMemoryItem> {
    return this.save(item)
  }

  private filePath(projectId: string): string {
    return path.join(this.baseDir, `${this.kind}-${safeProjectId(projectId)}.jsonl`)
  }

  private async loadLatest(projectId: string): Promise<LongTermMemoryItem[]> {
    const normalizedProjectId = safeProjectId(projectId)
    const filePath = this.filePath(normalizedProjectId)
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      return []
    }
    const latest = new Map<string, LongTermMemoryItem>()
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const item = JSON.parse(line) as LongTermMemoryItem
        if (item.kind !== this.kind || item.projectId !== normalizedProjectId) continue
        latest.set(item.id, item)
      } catch {
        // Ignore a partial append or malformed historical record.
      }
    }
    return [...latest.values()].sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
  }

  async save(
    item: Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string },
  ): Promise<LongTermMemoryItem> {
    if (!item.content.trim()) throw new Error('Long-term memory content cannot be empty.')
    if (item.confidence < 0 || item.confidence > 1) throw new Error('Memory confidence must be between 0 and 1.')
    const record: LongTermMemoryItem = {
      ...item,
      content: redactMemoryContent(item.content.trim()),
      id: item.id ?? createId('memory'),
      kind: this.kind,
      projectId: safeProjectId(item.projectId),
      tags: [...new Set(item.tags)],
      status: item.status ?? 'active',
      updatedAt: item.updatedAt ?? item.createdAt,
      usageCount: item.usageCount ?? 0,
      successCount: item.successCount ?? 0,
      failureCount: item.failureCount ?? 0,
      trustLevel: item.trustLevel ?? defaultMemoryTrust(item.source, item.content),
      schemaVersion: item.schemaVersion ?? 1,
    }
    await mkdir(this.baseDir, { recursive: true })
    await appendFile(this.filePath(record.projectId), `${JSON.stringify(record)}\n`, 'utf8')
    return record
  }

  async list(projectId: string, now = new Date().toISOString()): Promise<LongTermMemoryItem[]> {
    const items = await this.loadLatest(projectId)
    return items.filter(item =>
      item.status !== 'archived' && item.status !== 'superseded' && (!item.expiresAt || item.expiresAt > now),
    )
  }

  async search(query: MemorySearchQuery): Promise<LongTermMemoryItem[]> {
    const items = await this.list(query.projectId, query.now)
    const queryTokens = tokenize(query.text ?? '')
    const wantedTags = new Set(query.tags ?? [])
    return items
      .map(item => {
        const itemTokens = tokenize(`${item.content} ${item.category ?? ''} ${item.tags.join(' ')}`)
        const textScore = [...queryTokens].filter(token => itemTokens.has(token)).length
        const categoryScore = query.category && item.category === query.category ? 3 : 0
        const tagScore = [...wantedTags].filter(tag => item.tags.includes(tag)).length * 2
        const confidenceScore = item.confidence
        return { item, score: textScore + categoryScore + tagScore + confidenceScore }
      })
      .filter(entry => queryTokens.size === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt))
      .slice(0, query.limit ?? 10)
      .map(entry => entry.item)
  }

  async archive(projectId: string, id: string, archivedAt = new Date().toISOString()): Promise<boolean> {
    const item = (await this.loadLatest(projectId)).find(record => record.id === id)
    if (!item) return false
    await this.save({ ...item, id, expiresAt: archivedAt, status: 'archived', updatedAt: archivedAt })
    return true
  }

  async reinforce(
    projectId: string,
    id: string,
    outcome: 'used' | 'successful' | 'failed',
    now = new Date().toISOString(),
  ): Promise<LongTermMemoryItem | null> {
    const item = (await this.loadLatest(projectId)).find(record => record.id === id)
    if (!item || item.status === 'archived' || item.status === 'superseded') return null
    const successCount = (item.successCount ?? 0) + (outcome === 'successful' ? 1 : 0)
    const failureCount = (item.failureCount ?? 0) + (outcome === 'failed' ? 1 : 0)
    const confidenceDelta = outcome === 'successful' ? 0.03 : outcome === 'failed' ? -0.05 : 0
    return this.save({
      ...item,
      id,
      usageCount: (item.usageCount ?? 0) + (outcome === 'used' ? 1 : 0),
      successCount,
      failureCount,
      confidence: Math.max(0, Math.min(1, item.confidence + confidenceDelta)),
      lastUsedAt: now,
      updatedAt: now,
    })
  }

  async enforceCapacity(projectId: string, maxItems: number, now = new Date().toISOString()): Promise<string[]> {
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error('Memory capacity must be a positive integer.')
    const items = await this.list(projectId, now)
    if (items.length <= maxItems) return []
    const ranked = [...items].sort((a, b) => {
      const utility = (item: LongTermMemoryItem) =>
        (item.source === 'human' ? 4 : 0) + item.confidence * 2 + Math.log1p(item.usageCount ?? 0)
        + (item.successCount ?? 0) * 0.25 - (item.failureCount ?? 0) * 0.5
      return utility(b) - utility(a)
        || (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt)
    })
    const archived: string[] = []
    for (const item of ranked.slice(maxItems)) {
      await this.archive(projectId, item.id, now)
      archived.push(item.id)
    }
    return archived
  }
}
