import type {
  LongTermMemoryItem,
  MemoryStore,
  MemoryRetrievalConfig,
  MemoryRetrievalScore,
  MemorySearchQuery,
} from './types.js'
import { EpisodicMemoryStore } from './episodic.js'
import { SemanticMemoryStore } from './semantic.js'
import { FindingFeedbackStore } from './feedback.js'
import { memoryDecayWeight } from './decay.js'
export { memoryDecayWeight } from './decay.js'

export interface MemoryEmbeddingProvider {
  readonly dimensions?: number
  embed(text: string): Promise<number[]>
}

const synonymGroups: Record<string, string> = {
  auth: 'authorization', authenticate: 'authorization', authentication: 'authorization', authorize: 'authorization',
  crash: 'failure', failed: 'failure', error: 'failure', exception: 'failure',
  retrying: 'retry', retries: 'retry', timeout: 'timeout', timedout: 'timeout',
  vuln: 'security', vulnerability: 'security', insecure: 'security',
}

export function memoryTerms(value: string): string[] {
  const raw = value.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]+/gu) ?? []
  const terms: string[] = []
  for (const token of raw) {
    if (/^[\u4e00-\u9fff]+$/u.test(token) && token.length > 1) {
      for (let index = 0; index < token.length - 1; index += 1) terms.push(token.slice(index, index + 2))
    } else {
      terms.push(synonymGroups[token] ?? token)
    }
  }
  return terms
}

function hashTerm(term: string): number {
  let hash = 2166136261
  for (const character of term) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export class HashMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly dimensions: number

  constructor(dimensions = 128) { this.dimensions = dimensions }

  async embed(text: string): Promise<number[]> {
    const vector = Array.from({ length: this.dimensions }, () => 0)
    for (const term of memoryTerms(text)) {
      const hash = hashTerm(term)
      vector[hash % this.dimensions]! += (hash & 1) === 0 ? 1 : -1
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    return vector.map(value => value / norm)
  }
}

export class OpenAICompatibleMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly dimensions: number

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
    dimensions: number,
    private readonly timeoutMs = 30_000,
  ) {
    this.dimensions = dimensions
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text, dimensions: this.dimensions }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}.`)
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> }
      const embedding = payload.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('Embedding response did not contain a valid vector.')
      }
      if (embedding.length !== this.dimensions) {
        throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}, received ${embedding.length}.`)
      }
      return embedding
    } finally {
      clearTimeout(timeout)
    }
  }
}

const DEFAULT_RETRIEVAL_CONFIG: MemoryRetrievalConfig = {
  semantic: true,
  recency: true,
  reinforcement: true,
  conflictResolution: true,
  deduplication: true,
}

function cosine(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length)
  let score = 0
  for (let index = 0; index < size; index += 1) score += left[index]! * right[index]!
  return Math.max(0, score)
}

function lexicalScore(query: Set<string>, item: Set<string>): number {
  if (query.size === 0) return 1
  const overlap = [...query].filter(term => item.has(term)).length
  return overlap / Math.sqrt(query.size * Math.max(1, item.size))
}

function memoryText(item: LongTermMemoryItem): string {
  return `${item.content} ${item.category ?? ''} ${item.tags.join(' ')}`
}

export function memoryConflictKey(item: LongTermMemoryItem): string | undefined {
  for (const key of ['conflictKey', 'findingKey', 'factKey']) {
    const value = item.metadata?.[key]
    if (typeof value === 'string' && value.trim()) return `${key}:${value}`
  }
  if (item.kind === 'feedback' && typeof item.metadata?.findingId === 'string') {
    return `feedback:findingId:${item.metadata.findingId}`
  }
  return undefined
}

function deduplicationKey(item: LongTermMemoryItem): string {
  return item.content.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z0-9_\u4e00-\u9fff]+/gu, ' ').trim()
}

function preferredConflict(left: LongTermMemoryItem, right: LongTermMemoryItem): LongTermMemoryItem {
  const sourceRank = (item: LongTermMemoryItem) => item.source === 'human' ? 3 : item.source === 'system' ? 2 : 1
  const rankDifference = sourceRank(left) - sourceRank(right)
  if (rankDifference !== 0) return rankDifference > 0 ? left : right
  const leftTime = left.updatedAt ?? left.createdAt
  const rightTime = right.updatedAt ?? right.createdAt
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right
  return left.confidence >= right.confidence ? left : right
}

function reinforcementScore(item: LongTermMemoryItem): number {
  const successes = item.successCount ?? 0
  const failures = item.failureCount ?? 0
  const quality = (successes + 1) / (successes + failures + 2)
  return Math.min(1, quality * 0.7 + Math.log1p(item.usageCount ?? 0) / 10)
}

function authorityScore(item: LongTermMemoryItem): number {
  if (item.source === 'human') return 1
  if (item.source === 'system') return 0.7
  return 0.5
}

function similarity(left: LongTermMemoryItem, right: LongTermMemoryItem): number {
  const leftTerms = new Set(memoryTerms(memoryText(left)))
  const rightTerms = new Set(memoryTerms(memoryText(right)))
  const union = new Set([...leftTerms, ...rightTerms]).size
  if (union === 0) return 0
  return [...leftTerms].filter(term => rightTerms.has(term)).length / union
}

function diversify(items: LongTermMemoryItem[], limit: number): LongTermMemoryItem[] {
  const remaining = [...items]
  const selected: LongTermMemoryItem[] = []
  while (remaining.length > 0 && selected.length < limit) {
    remaining.sort((left, right) => {
      const adjusted = (item: LongTermMemoryItem) =>
        (item.retrieval?.total ?? 0) - Math.max(0, ...selected.map(chosen => similarity(item, chosen))) * 0.15
      return adjusted(right) - adjusted(left)
    })
    selected.push(remaining.shift()!)
  }
  return selected
}

export class MemoryRetriever {
  constructor(
    private readonly episodic: MemoryStore = new EpisodicMemoryStore(),
    private readonly semantic: MemoryStore = new SemanticMemoryStore(),
    private readonly feedback: MemoryStore = new FindingFeedbackStore(),
    private readonly embeddings: MemoryEmbeddingProvider = new HashMemoryEmbeddingProvider(),
    private readonly procedural?: MemoryStore,
  ) {}

  async retrieve(
    query: MemorySearchQuery,
    overrides: Partial<MemoryRetrievalConfig> = {},
  ): Promise<LongTermMemoryItem[]> {
    const config = { ...DEFAULT_RETRIEVAL_CONFIG, ...overrides }
    const stores: MemoryStore[] = [this.episodic, this.semantic, this.feedback, ...(this.procedural ? [this.procedural] : [])]
    const listed = await Promise.all(stores.map(store => store.list(query.projectId, query.now)))
    const queryTerms = new Set(memoryTerms(query.text ?? ''))
    const queryVector = config.semantic ? await this.embeddings.embed(query.text ?? '') : []
    const vectorHits = config.semantic
      ? await Promise.all(stores.map(store => store.searchVector?.(query, queryVector) ?? Promise.resolve([])))
      : stores.map(() => [])
    const vectorScores = new Map(vectorHits.flat().map(hit => [hit.id, hit.score]))
    const episodic = listed[0] ?? []
    const semantic = listed[1] ?? []
    const feedback = listed[2] ?? []
    const procedural = listed[3] ?? []
    const now = query.now ? new Date(query.now) : new Date()
    const wantedTags = new Set(query.tags ?? [])
    const scored = await Promise.all([...semantic, ...episodic, ...procedural, ...feedback]
      .filter(item => !query.category || item.category === query.category)
      .filter(item => wantedTags.size === 0 || [...wantedTags].some(tag => item.tags.includes(tag)))
      .filter(item => item.source === 'human' || item.confidence >= 0.55)
      .map(async item => {
        const lexical = lexicalScore(queryTerms, new Set(memoryTerms(memoryText(item))))
        const semanticScore = config.semantic
          ? (vectorScores.get(item.id) ?? cosine(queryVector, await this.embeddings.embed(memoryText(item))))
          : 0
        const recency = config.recency ? memoryDecayWeight(item, now) : 1
        const reinforcement = config.reinforcement ? reinforcementScore(item) : 0.5
        const authority = authorityScore(item)
        const categoryBoost = query.category && item.category === query.category ? 0.1 : 0
        const score: MemoryRetrievalScore = {
          total: lexical * 0.34 + semanticScore * 0.28 + item.confidence * recency * 0.16
            + reinforcement * 0.1 + authority * 0.12 + categoryBoost,
          lexical,
          semantic: semanticScore,
          recency,
          reinforcement,
          authority,
          conflictKey: memoryConflictKey(item),
        }
        return { ...item, retrieval: score }
      }))
    const relevant = scored
      .filter(item => queryTerms.size === 0 || (item.retrieval?.lexical ?? 0) > 0 || (item.retrieval?.semantic ?? 0) > 0.05)
      .sort((a, b) => (b.retrieval?.total ?? 0) - (a.retrieval?.total ?? 0)
        || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))

    let candidates: LongTermMemoryItem[] = relevant
    if (config.conflictResolution) {
      const unkeyed: LongTermMemoryItem[] = []
      const conflicts = new Map<string, { winner: LongTermMemoryItem; count: number }>()
      for (const item of candidates) {
        const key = memoryConflictKey(item)
        if (!key) {
          unkeyed.push(item)
          continue
        }
        const current = conflicts.get(key)
        conflicts.set(key, current
          ? { winner: preferredConflict(current.winner, item), count: current.count + 1 }
          : { winner: item, count: 1 })
      }
      candidates = [...unkeyed, ...[...conflicts.values()].map(({ winner, count }) => ({
        ...winner,
        retrieval: winner.retrieval ? { ...winner.retrieval, suppressedConflicts: count - 1 } : undefined,
      }))].sort((a, b) => (b.retrieval?.total ?? 0) - (a.retrieval?.total ?? 0))
    }
    const selected: LongTermMemoryItem[] = []
    const seen = new Set<string>()
    for (const item of candidates) {
      const key = config.deduplication ? deduplicationKey(item) : `${item.kind}:${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      selected.push(item)
    }
    return diversify(selected, query.limit ?? 10)
  }
}

export function buildMemorySearchQuery(projectId: string, text: string, category?: string): MemorySearchQuery {
  return { projectId, text, category, limit: 8 }
}
