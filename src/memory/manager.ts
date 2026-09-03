import crypto from 'node:crypto'
import type { ChatMessage } from '../types.js'
import type { WorkingMemory } from '../runtime/types.js'
import { EpisodicMemoryStore } from './episodic.js'
import { FindingFeedbackStore } from './feedback.js'
import { HashMemoryEmbeddingProvider, MemoryEmbeddingProvider, MemoryRetriever, OpenAICompatibleMemoryEmbeddingProvider, buildMemorySearchQuery } from './retriever.js'
import { SemanticMemoryStore } from './semantic.js'
import { MemoryConsolidator } from './consolidator.js'
import { PostgresLongTermMemoryStore } from './postgres-store.js'
import { LongTermMemoryStore } from './store.js'
import { evaluateMemoryWrite } from './write-policy.js'
import { extractMemoryCandidates } from './extractor.js'
import type { FindingFeedback, LongTermMemoryItem, MemoryCapacityPolicy, MemoryRetrievalConfig, MemoryStore } from './types.js'

export const DEFAULT_MEMORY_CAPACITY: MemoryCapacityPolicy = {
  episodic: 500,
  semantic: 1_000,
  procedural: 500,
  feedback: 500,
}

export function projectMemoryId(cwd: string): string {
  return `project-${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`
}

export class AgentMemoryManager {
  readonly projectId: string
  readonly episodic: MemoryStore
  readonly semantic: MemoryStore
  readonly procedural: MemoryStore
  readonly feedback: MemoryStore
  readonly retriever: MemoryRetriever
  readonly consolidator: MemoryConsolidator
  private lastRetrieved: Array<Pick<LongTermMemoryItem, 'id' | 'kind'>> = []

  constructor(cwd: string, baseDir?: string, options: {
    backend?: 'jsonl' | 'postgres'
    postgresUrl?: string
    embeddingDimensions?: number
    embeddingProvider?: 'hash' | 'remote'
    embeddingEndpoint?: string
    embeddingApiKey?: string
    embeddingModel?: string
  } = {}) {
    this.projectId = projectMemoryId(cwd)
    const backend = options.backend ?? (String(process.env.PR_GUARD_MEMORY_BACKEND ?? 'jsonl').trim().toLowerCase() as 'jsonl' | 'postgres')
    const usePostgres = backend === 'postgres'
    const postgresUrl = options.postgresUrl ?? process.env.PR_GUARD_POSTGRES_URL
    const dimensions = options.embeddingDimensions ?? Number(process.env.PR_GUARD_EMBEDDING_DIMENSIONS ?? 1536)
    const embeddings = options.embeddingProvider === 'remote' && options.embeddingEndpoint && options.embeddingApiKey && options.embeddingModel
      ? new OpenAICompatibleMemoryEmbeddingProvider(options.embeddingEndpoint, options.embeddingApiKey, options.embeddingModel, dimensions)
      : options.embeddingProvider === 'hash'
        ? new HashMemoryEmbeddingProvider(dimensions)
        : this.createEmbeddingProvider(dimensions, options)
    const embed = (text: string) => embeddings.embed(text)
    const embeddingInfo = { model: options.embeddingModel ?? process.env.PR_GUARD_EMBEDDING_MODEL, dimensions }
    this.episodic = usePostgres ? new PostgresLongTermMemoryStore('episodic', postgresUrl, undefined, embed, embeddingInfo) : new EpisodicMemoryStore(baseDir)
    this.semantic = usePostgres ? new PostgresLongTermMemoryStore('semantic', postgresUrl, undefined, embed, embeddingInfo) : new SemanticMemoryStore(baseDir)
    this.procedural = usePostgres ? new PostgresLongTermMemoryStore('procedural', postgresUrl, undefined, embed, embeddingInfo) : new LongTermMemoryStore('procedural', baseDir)
    this.feedback = usePostgres ? new PostgresLongTermMemoryStore('feedback', postgresUrl, undefined, embed, embeddingInfo) : new FindingFeedbackStore(baseDir)
    this.retriever = new MemoryRetriever(this.episodic, this.semantic, this.feedback, embeddings, this.procedural)
    this.consolidator = new MemoryConsolidator(this.episodic, this.semantic)
  }

  private createEmbeddingProvider(dimensions: number, options: {
    embeddingEndpoint?: string
    embeddingApiKey?: string
    embeddingModel?: string
  }): MemoryEmbeddingProvider {
    const provider = String(process.env.PR_GUARD_EMBEDDING_PROVIDER ?? 'hash').trim().toLowerCase()
    const endpoint = options.embeddingEndpoint ?? process.env.PR_GUARD_EMBEDDING_ENDPOINT
    const apiKey = options.embeddingApiKey ?? process.env.PR_GUARD_EMBEDDING_API_KEY
    const model = options.embeddingModel ?? process.env.PR_GUARD_EMBEDDING_MODEL
    if (provider === 'remote' && endpoint && apiKey && model) {
      return new OpenAICompatibleMemoryEmbeddingProvider(endpoint, apiKey, model, dimensions)
    }
    return new HashMemoryEmbeddingProvider(dimensions)
  }

  async retrieve(
    text: string,
    category?: string,
    config: Partial<MemoryRetrievalConfig> = {},
  ): Promise<LongTermMemoryItem[]> {
    const items = await this.retriever.retrieve(buildMemorySearchQuery(this.projectId, text, category), config)
    this.lastRetrieved = items.map(item => ({ id: item.id, kind: item.kind }))
    const stores: Record<LongTermMemoryItem['kind'], MemoryStore> = {
      episodic: this.episodic, semantic: this.semantic,
      procedural: this.procedural, feedback: this.feedback,
    }
    await Promise.all(items.map(item => stores[item.kind].reinforce(this.projectId, item.id, 'used')))
    return items
  }

  async reinforceLastRetrieval(outcome: 'successful' | 'failed'): Promise<void> {
    const selected = this.lastRetrieved
    this.lastRetrieved = []
    const stores: Record<LongTermMemoryItem['kind'], MemoryStore> = {
      episodic: this.episodic, semantic: this.semantic,
      procedural: this.procedural, feedback: this.feedback,
    }
    await Promise.all(selected.map(item => stores[item.kind].reinforce(this.projectId, item.id, outcome)))
  }

  consolidate(options: { minOccurrences?: number; now?: string } = {}): Promise<LongTermMemoryItem[]> {
    return this.consolidator.consolidate(this.projectId, options)
  }

  async governCapacity(policy: Partial<MemoryCapacityPolicy> = {}, now = new Date().toISOString()): Promise<Record<LongTermMemoryItem['kind'], string[]>> {
    const effective = { ...DEFAULT_MEMORY_CAPACITY, ...policy }
    const [episodic, semantic, procedural, feedback] = await Promise.all([
      this.episodic.enforceCapacity(this.projectId, effective.episodic, now),
      this.semantic.enforceCapacity(this.projectId, effective.semantic, now),
      this.procedural.enforceCapacity(this.projectId, effective.procedural, now),
      this.feedback.enforceCapacity(this.projectId, effective.feedback, now),
    ])
    return { episodic, semantic, procedural, feedback }
  }

  async retryFailedEmbeddings(limit = 20): Promise<{ completed: number; failed: number }> {
    const stores = [this.episodic, this.semantic, this.procedural, this.feedback]
    const results = await Promise.all(stores.map(store => store.retryFailedEmbeddings?.(limit) ?? { completed: 0, failed: 0 }))
    return results.reduce((total, result) => ({
      completed: total.completed + result.completed,
      failed: total.failed + result.failed,
    }), { completed: 0, failed: 0 })
  }

  async recordTurn(args: {
    userInput: string
    messages: ChatMessage[]
    workingMemory?: WorkingMemory
    outcome?: 'completed' | 'failed' | 'cancelled'
  }): Promise<LongTermMemoryItem | null> {
    const assistant = [...args.messages].reverse().find(message => message.role === 'assistant')
    const assistantText = assistant?.role === 'assistant' ? assistant.content : ''
    const facts = args.workingMemory?.discoveredFacts.slice(-5).map(fact => `${fact.key}: ${fact.value}`) ?? []
    const decision = evaluateMemoryWrite({
      userInput: args.userInput,
      assistantText,
      factCount: facts.length,
      outcome: args.outcome,
    })
    if (!decision.shouldRemember) return null
    const content = [
      `User request: ${args.userInput.trim()}`,
      assistantText ? `Assistant outcome: ${assistantText.slice(0, 1200)}` : '',
      facts.length > 0 ? `Facts: ${facts.join('; ')}` : '',
    ].filter(Boolean).join('\n')
    const episodic = await this.episodic.remember({
      projectId: this.projectId,
      content,
      source: 'agent',
      category: 'conversation',
      tags: [args.outcome ?? 'completed'],
      confidence: args.outcome === 'completed' ? 0.8 : 0.65,
      createdAt: new Date().toISOString(),
      provenance: {
        generatedBy: 'agent-observation',
        observedAt: new Date().toISOString(),
      },
      metadata: { outcome: args.outcome ?? 'completed' },
    })
    await Promise.all(facts.map(fact => this.semantic.remember({
      projectId: this.projectId,
      content: fact,
      source: 'agent',
      category: 'project-fact',
      tags: ['derived'],
      confidence: 0.75,
      createdAt: new Date().toISOString(),
      provenance: {
        generatedBy: 'semantic-consolidation',
        sourceMemoryIds: [episodic.id],
        observedAt: new Date().toISOString(),
      },
      metadata: { derivedFrom: episodic.id, factKey: fact.split(':', 1)[0] },
    })))
    const candidates = extractMemoryCandidates({
      userInput: args.userInput,
      assistantText,
      facts,
      outcome: args.outcome,
    })
    await Promise.all(candidates.map(candidate => this[candidate.kind].remember({
      projectId: this.projectId,
      content: candidate.content,
      source: 'agent',
      category: candidate.category,
      tags: candidate.tags,
      confidence: candidate.importance,
      createdAt: new Date().toISOString(),
      provenance: {
        generatedBy: 'agent-observation',
        sourceMemoryIds: [episodic.id],
        observedAt: new Date().toISOString(),
      },
      metadata: { derivedFrom: episodic.id, importance: candidate.importance },
    })))
    await this.reinforceLastRetrieval(args.outcome === 'completed' ? 'successful' : 'failed')
    await this.consolidate()
    await this.governCapacity()
    return episodic
  }

  rememberFeedback(input: Omit<FindingFeedback, 'id' | 'kind'> & { id?: string }): Promise<FindingFeedback> {
    return this.feedback.remember(input) as Promise<FindingFeedback>
  }
}
