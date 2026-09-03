import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR, loadRuntimeConfig } from '../config.js'
import { HashMemoryEmbeddingProvider, OpenAICompatibleMemoryEmbeddingProvider, type MemoryEmbeddingProvider } from './retriever.js'
import { PostgresLongTermMemoryStore } from './postgres-store.js'
import type { LongTermMemoryItem } from './types.js'

type MigrationOptions = {
  sourceDir?: string
  postgresUrl: string
  embeddingProvider: MemoryEmbeddingProvider
}

export type MigrationReport = {
  files: number
  records: number
  migrated: number
  failed: Array<{ id: string; error: string }>
}

function isMemoryItem(value: unknown): value is LongTermMemoryItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LongTermMemoryItem>
  return typeof item.id === 'string'
    && typeof item.projectId === 'string'
    && typeof item.kind === 'string'
    && typeof item.content === 'string'
    && typeof item.source === 'string'
    && typeof item.confidence === 'number'
    && typeof item.createdAt === 'string'
}

async function readLatestRecords(sourceDir: string): Promise<{ files: number; records: LongTermMemoryItem[] }> {
  let names: string[]
  try {
    names = (await readdir(sourceDir)).filter(name => name.endsWith('.jsonl'))
  } catch {
    return { files: 0, records: [] }
  }
  const latest = new Map<string, LongTermMemoryItem>()
  for (const name of names) {
    const content = await readFile(path.join(sourceDir, name), 'utf8')
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (isMemoryItem(parsed)) latest.set(parsed.id, parsed)
      } catch {
        // Ignore malformed or partial historical lines.
      }
    }
  }
  return { files: names.length, records: [...latest.values()] }
}

export async function migrateJsonlToPostgres(options: MigrationOptions): Promise<MigrationReport> {
  const sourceDir = options.sourceDir ?? path.join(MINI_CODE_DIR, 'runtime', 'long-term-memory')
  const input = await readLatestRecords(sourceDir)
  const stores = new Map<LongTermMemoryItem['kind'], PostgresLongTermMemoryStore>()
  const report: MigrationReport = { files: input.files, records: input.records.length, migrated: 0, failed: [] }
  try {
    for (const item of input.records) {
      try {
        let store = stores.get(item.kind)
        if (!store) {
          store = new PostgresLongTermMemoryStore(item.kind, options.postgresUrl, undefined, text => options.embeddingProvider.embed(text))
          stores.set(item.kind, store)
        }
        const { id: _id, kind: _kind, ...record } = item
        await store.save({ ...record, id: item.id })
        report.migrated += 1
      } catch (error) {
        report.failed.push({ id: item.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    await Promise.all([...stores.values()].map(store => store.close()))
  }
  return report
}

async function main(): Promise<void> {
  const runtime = await loadRuntimeConfig()
  if (!runtime.prGuardPostgresUrl) throw new Error('PR_GUARD_POSTGRES_URL is required.')
  const dimensions = runtime.prGuardEmbeddingDimensions ?? 1536
  const embedding = runtime.prGuardEmbeddingProvider === 'remote'
    && runtime.prGuardEmbeddingEndpoint
    && runtime.prGuardEmbeddingApiKey
    && runtime.prGuardEmbeddingModel
    ? new OpenAICompatibleMemoryEmbeddingProvider(runtime.prGuardEmbeddingEndpoint, runtime.prGuardEmbeddingApiKey, runtime.prGuardEmbeddingModel, dimensions)
    : new HashMemoryEmbeddingProvider(dimensions)
  const report = await migrateJsonlToPostgres({
    postgresUrl: runtime.prGuardPostgresUrl,
    embeddingProvider: embedding,
  })
  console.log(JSON.stringify(report, null, 2))
  if (report.failed.length > 0) process.exitCode = 1
}

await main()
