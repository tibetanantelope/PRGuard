import { loadRuntimeConfig } from '../config.js'
import { AgentMemoryManager } from './manager.js'

const runtime = await loadRuntimeConfig()
if (runtime.prGuardMemoryBackend !== 'postgres') throw new Error('PR_GUARD_MEMORY_BACKEND must be postgres.')
if (runtime.prGuardEmbeddingProvider !== 'remote') throw new Error('PR_GUARD_EMBEDDING_PROVIDER must be remote.')

const manager = new AgentMemoryManager(process.cwd(), undefined, {
  backend: 'postgres',
  postgresUrl: runtime.prGuardPostgresUrl,
  embeddingProvider: 'remote',
  embeddingEndpoint: runtime.prGuardEmbeddingEndpoint,
  embeddingApiKey: runtime.prGuardEmbeddingApiKey,
  embeddingModel: runtime.prGuardEmbeddingModel,
  embeddingDimensions: runtime.prGuardEmbeddingDimensions,
})

const createdAt = new Date().toISOString()
const memory = await manager.episodic.remember({
  projectId: manager.projectId,
  content: 'Smoke test memory: pgvector retrieves a PostgreSQL connection-pool retry strategy.',
  source: 'system',
  category: 'integration-test',
  tags: ['smoke-test'],
  confidence: 1,
  createdAt,
})
const retrieved = await manager.retrieve('How should PostgreSQL connection-pool failures be retried?')
const hit = retrieved.find(item => item.id === memory.id)
await manager.episodic.archive(manager.projectId, memory.id)

console.log(JSON.stringify({
  memoryId: memory.id,
  retrievedCount: retrieved.length,
  hit: Boolean(hit),
  semanticScore: hit?.retrieval?.semantic ?? null,
  totalScore: hit?.retrieval?.total ?? null,
  archived: true,
}, null, 2))

for (const store of [manager.episodic, manager.semantic, manager.procedural, manager.feedback]) {
  const close = (store as { close?: () => Promise<void> }).close
  if (close) await close.call(store)
}

if (!hit) process.exitCode = 1
