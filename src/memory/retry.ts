import { loadRuntimeConfig } from '../config.js'
import { AgentMemoryManager } from './manager.js'

const runtime = await loadRuntimeConfig()
if (runtime.prGuardMemoryBackend !== 'postgres') throw new Error('PR_GUARD_MEMORY_BACKEND must be postgres.')
const manager = new AgentMemoryManager(process.cwd(), undefined, {
  backend: 'postgres',
  postgresUrl: runtime.prGuardPostgresUrl,
  embeddingProvider: runtime.prGuardEmbeddingProvider,
  embeddingEndpoint: runtime.prGuardEmbeddingEndpoint,
  embeddingApiKey: runtime.prGuardEmbeddingApiKey,
  embeddingModel: runtime.prGuardEmbeddingModel,
  embeddingDimensions: runtime.prGuardEmbeddingDimensions,
})
console.log(JSON.stringify(await manager.retryFailedEmbeddings(), null, 2))
for (const store of [manager.episodic, manager.semantic, manager.procedural, manager.feedback]) {
  const close = (store as { close?: () => Promise<void> }).close
  if (close) await close.call(store)
}
