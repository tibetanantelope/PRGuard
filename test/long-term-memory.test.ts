import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentMemoryManager, EpisodicMemoryStore, FindingFeedbackStore, MemoryRetriever, SemanticMemoryStore } from '../src/memory/index.js'

test('long-term memory stores project-scoped episodic and semantic records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-long-memory-'))
  try {
    const episodic = new EpisodicMemoryStore(dir)
    const semantic = new SemanticMemoryStore(dir)
    await episodic.remember({ projectId: 'project-1', content: 'Previous review found missing authorization', source: 'agent', category: 'security', tags: ['auth'], confidence: 0.9, createdAt: '2026-09-02T00:00:00.000Z' })
    await semantic.remember({ projectId: 'project-1', content: 'All API endpoints require authorization checks', source: 'human', category: 'security', tags: ['auth'], confidence: 1, createdAt: '2026-09-02T00:01:00.000Z' })
    assert.equal((await episodic.search({ projectId: 'project-1', text: 'authorization' })).length, 1)
    assert.equal((await episodic.list('project-2')).length, 0)
    const retrieved = await new MemoryRetriever(episodic, semantic).retrieve({ projectId: 'project-1', text: 'authorization', limit: 5 })
    assert.equal(retrieved.length, 2)
    assert.equal(retrieved[0]?.source, 'human')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('feedback memory keeps the latest decision for a finding ID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-feedback-memory-'))
  try {
    const feedback = new FindingFeedbackStore(dir)
    await feedback.remember({ projectId: 'project-1', content: 'SQL warning was accepted', source: 'human', tags: ['sql'], confidence: 1, createdAt: '2026-09-02T00:00:00.000Z', metadata: { findingId: 'f-1', decision: 'accepted' } })
    await feedback.remember({ id: 'f-1-feedback', projectId: 'project-1', content: 'SQL warning was rejected as a false positive', source: 'human', tags: ['sql'], confidence: 1, createdAt: '2026-09-02T00:01:00.000Z', metadata: { findingId: 'f-1', decision: 'rejected' } })
    const records = await feedback.list('project-1')
    assert.equal(records.length, 2)
    assert.equal((await feedback.latestForFinding('project-1', 'f-1'))?.metadata?.decision, 'rejected')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent memory manager closes the retrieve and write loop', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-memory-manager-'))
  try {
    const manager = new AgentMemoryManager('/workspace/demo-project', dir)
    await manager.recordTurn({
      userInput: 'Investigate authorization failures',
      messages: [{ role: 'assistant', content: 'Found an authorization gap in the API.' }],
      outcome: 'completed',
    })
    const memories = await manager.retrieve('authorization API')
    assert.equal(memories.length, 1)
    assert.match(memories[0]?.content ?? '', /authorization/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
