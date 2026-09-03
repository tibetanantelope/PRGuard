export type LongTermMemoryKind = 'episodic' | 'semantic' | 'procedural' | 'feedback'

export type LongTermMemoryItem = {
  id: string
  kind: LongTermMemoryKind
  projectId: string
  content: string
  source: 'human' | 'agent' | 'system'
  category?: string
  tags: string[]
  confidence: number
  createdAt: string
  updatedAt?: string
  lastUsedAt?: string
  usageCount?: number
  successCount?: number
  failureCount?: number
  expiresAt?: string
  status?: 'active' | 'superseded' | 'archived'
  provenance?: MemoryProvenance
  retrieval?: MemoryRetrievalScore
  metadata?: Record<string, unknown>
  embeddingStatus?: 'pending' | 'ready' | 'failed'
  embeddingAttempts?: number
  embeddingLastError?: string
  trustLevel?: 'untrusted' | 'observed' | 'human_verified'
  embeddingModel?: string
  embeddingDimensions?: number
  schemaVersion?: number
}

export type MemoryProvenance = {
  generatedBy: 'human-feedback' | 'agent-observation' | 'semantic-consolidation' | 'system-event'
  sourceMemoryIds?: string[]
  runId?: string
  reviewId?: string
  findingId?: string
  evidenceRefs?: string[]
  observedAt: string
}

export type MemoryRetrievalScore = {
  total: number
  lexical: number
  semantic: number
  recency: number
  reinforcement: number
  authority: number
  conflictKey?: string
  suppressedConflicts?: number
}

export type FindingFeedback = LongTermMemoryItem & {
  kind: 'feedback'
  metadata: {
    findingId: string
    decision: 'accepted' | 'rejected' | 'modified'
    reason?: string
    [key: string]: unknown
  }
}

export type MemorySearchQuery = {
  projectId: string
  text?: string
  category?: string
  tags?: string[]
  limit?: number
  now?: string
}

export type MemoryRetrievalConfig = {
  semantic: boolean
  recency: boolean
  reinforcement: boolean
  conflictResolution: boolean
  deduplication: boolean
  allowUntrusted?: boolean
}

export type MemoryCapacityPolicy = {
  episodic: number
  semantic: number
  procedural: number
  feedback: number
}

export type MemoryStore = {
  kind: LongTermMemoryKind
  save(item: Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }): Promise<LongTermMemoryItem>
  remember(item: Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }): Promise<LongTermMemoryItem>
  list(projectId: string, now?: string): Promise<LongTermMemoryItem[]>
  getByIds?(projectId: string, ids: string[]): Promise<LongTermMemoryItem[]>
  search(query: MemorySearchQuery): Promise<LongTermMemoryItem[]>
  searchVector?(query: MemorySearchQuery, vector: number[]): Promise<Array<{ id: string; score: number }>>
  retryFailedEmbeddings?(limit?: number): Promise<{ completed: number; failed: number }>
  archive(projectId: string, id: string, archivedAt?: string): Promise<boolean>
  reinforce(projectId: string, id: string, outcome: 'used' | 'successful' | 'failed', now?: string): Promise<LongTermMemoryItem | null>
  enforceCapacity(projectId: string, maxItems: number, now?: string): Promise<string[]>
}
