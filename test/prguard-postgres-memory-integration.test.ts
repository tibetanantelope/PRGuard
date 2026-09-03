import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { test } from 'node:test'
import { HashMemoryEmbeddingProvider } from '../src/memory/retriever.js'
import { PostgresLongTermMemoryStore } from '../src/memory/postgres-store.js'

const { Client } = pg

test('PostgreSQL + pgvector stores and retrieves long-term memory', {
  skip: !process.env.PRGUARD_POSTGRES_INTEGRATION,
}, async () => {
  const connectionString = process.env.PR_GUARD_POSTGRES_URL ?? 'postgresql://prguard:prguard_dev_password@127.0.0.1:5432/prguard'
  const client = new Client({ connectionString })
  const provider = new HashMemoryEmbeddingProvider(1536)
  const store = new PostgresLongTermMemoryStore('episodic', connectionString, undefined, text => provider.embed(text))
  const projectId = `ci-project-${Date.now()}`

  try {
    await client.connect()
    await client.query(await readFile(new URL('../infra/postgres/init/002_memory.sql', import.meta.url), 'utf8'))
    const memory = await store.remember({
      projectId,
      content: 'CI verifies that PostgreSQL connection pool retries are bounded and observable.',
      source: 'system',
      category: 'integration-test',
      tags: ['ci'],
      confidence: 1,
      createdAt: new Date().toISOString(),
    })
    const vector = await provider.embed('How should PostgreSQL connection pool retries be handled?')
    const matches = await store.searchVector({ projectId, limit: 5 }, vector)
    assert.ok(matches.some(match => match.id === memory.id))
    assert.equal(await store.archive(projectId, memory.id), true)
  } finally {
    await store.close()
    await client.end().catch(() => undefined)
  }
})
