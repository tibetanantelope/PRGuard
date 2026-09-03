import crypto from 'node:crypto'
import type { LongTermMemoryItem, MemoryStore } from './types.js'
import { EpisodicMemoryStore } from './episodic.js'
import { SemanticMemoryStore } from './semantic.js'
import { memoryTerms } from './retriever.js'

function consolidationKey(item: LongTermMemoryItem): string {
  for (const key of ['semanticKey', 'factKey', 'findingKey', 'conflictKey']) {
    const value = item.metadata?.[key]
    if (typeof value === 'string' && value.trim()) return `${item.category ?? 'general'}:${value}`
  }
  const signature = [...new Set(memoryTerms(item.content))].sort().slice(0, 16).join('|')
  return `${item.category ?? 'general'}:${signature}`
}

function stableId(key: string): string {
  return `consolidated-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

export class MemoryConsolidator {
  constructor(
    private readonly episodic: MemoryStore,
    private readonly semantic: MemoryStore,
  ) {}

  async consolidate(
    projectId: string,
    options: { minOccurrences?: number; now?: string } = {},
  ): Promise<LongTermMemoryItem[]> {
    const minOccurrences = Math.max(2, options.minOccurrences ?? 2)
    const now = options.now ?? new Date().toISOString()
    const episodes = await this.episodic.list(projectId, now)
    const groups = new Map<string, LongTermMemoryItem[]>()
    for (const episode of episodes) {
      const key = consolidationKey(episode)
      groups.set(key, [...(groups.get(key) ?? []), episode])
    }
    const consolidated: LongTermMemoryItem[] = []
    for (const [key, group] of groups) {
      if (group.length < minOccurrences) continue
      const newest = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
      const sourceMemoryIds = [...new Set(group.flatMap(item => [item.id, ...(item.provenance?.sourceMemoryIds ?? [])]))]
      consolidated.push(await this.semantic.remember({
        id: stableId(key),
        projectId,
        content: `Consolidated pattern from ${group.length} episodes: ${newest.content}`,
        source: 'agent',
        category: newest.category,
        tags: [...new Set(group.flatMap(item => item.tags).concat('consolidated'))],
        confidence: Math.min(0.95, group.reduce((sum, item) => sum + item.confidence, 0) / group.length + 0.05),
        createdAt: newest.createdAt,
        updatedAt: now,
        provenance: {
          generatedBy: 'semantic-consolidation',
          sourceMemoryIds,
          observedAt: now,
        },
        metadata: { semanticKey: key, conflictKey: key, consolidatedCount: group.length },
      }))
    }
    return consolidated
  }
}
