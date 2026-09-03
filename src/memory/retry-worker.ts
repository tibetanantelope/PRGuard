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
const intervalMs = Number(process.env.PR_GUARD_MEMORY_RETRY_INTERVAL_MS ?? 30_000)
let stopping = false

async function close(): Promise<void> {
  for (const store of [manager.episodic, manager.semantic, manager.procedural, manager.feedback]) {
    const closeStore = (store as { close?: () => Promise<void> }).close
    if (closeStore) await closeStore.call(store)
  }
}

async function tick(): Promise<void> {
  if (stopping) return
  const result = await manager.retryFailedEmbeddings()
  if (result.completed > 0 || result.failed > 0) {
    console.log(JSON.stringify({ event: 'memory_embedding_retry', ...result }))
  }
}

const timer = setInterval(() => {
  void tick().catch(error => console.error(JSON.stringify({
    event: 'memory_embedding_retry_worker_error',
    error: error instanceof Error ? error.message : String(error),
  })))
}, Number.isFinite(intervalMs) && intervalMs >= 1_000 ? intervalMs : 30_000)

const stop = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  await close()
}
process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
await tick()
console.log(JSON.stringify({ event: 'memory_embedding_retry_worker_started', intervalMs }))
