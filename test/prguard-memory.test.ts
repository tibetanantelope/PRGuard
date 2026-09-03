import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PrGuardMemoryService, findingMemoryKey, redactMemoryText } from '../src/prguard/memory.js'
import type { Finding, Patch, PrDiffSnapshot, ReviewResult } from '../src/prguard/types.js'
import { RepairService, ReviewService } from '../src/prguard/services.js'
import { createPrGuardTrace, loadPrGuardTrace } from '../src/prguard/trace.js'
import { NoopReviewPersistence } from '../src/prguard/review-persistence.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ChatMessage, ModelAdapter } from '../src/types.js'

function finding(id = 'finding-1', confidence = 0.8): Finding {
  return {
    id, category: 'security', severity: 'high', confidence, status: 'open',
    file: 'src/api.ts', lineStart: 10, lineEnd: 10, title: 'Missing authorization check',
    evidence: [{ source: 'diff', file: 'src/api.ts', lineStart: 10, lineEnd: 10, content: '+ return secret', explanation: 'Endpoint returns protected data.' }],
    reason: 'The endpoint has no authorization guard.', suggestedFix: 'Add an authorization check.',
    verification: { status: 'pending', commands: [], passedCommands: [], failedCommands: [] },
  }
}

function review(item = finding()): ReviewResult {
  return {
    schemaVersion: '0.1', reviewId: 'review-1', createdAt: '2026-09-02T00:00:00.000Z',
    input: { cwd: 'D:/workspace/demo', diffText: 'diff --git a/src/api.ts b/src/api.ts\n+ return secret' },
    findings: [item],
    summary: { totalFindings: 1, bySeverity: { low: 0, medium: 0, high: 1, critical: 0 }, byCategory: { security: 1, reliability: 0, code_quality: 0 } },
  }
}

const snapshot: PrDiffSnapshot = {
  input: review().input,
  diffText: 'diff --git a/src/api.ts b/src/api.ts\n+ return secret',
  changedFiles: [{ path: 'src/api.ts', status: 'modified', additions: 1, deletions: 0, hunks: [] }],
  repository: { root: 'D:/workspace/demo', projectFiles: [], instructionFiles: [] },
}

const runtime: RuntimeConfig = {
  model: 'test-model', baseUrl: 'http://localhost', apiKey: 'test', mcpServers: {}, sourceSummary: 'test',
}

class RepeatedFindingModel implements ModelAdapter {
  calls: ChatMessage[][] = []

  async next(messages: ChatMessage[]) {
    this.calls.push(messages)
    return {
      type: 'assistant' as const,
      content: JSON.stringify({
        findings: [{
          id: `model-finding-${this.calls.length}`,
          category: 'security', severity: 'high', confidence: 0.8,
          file: 'src/api.ts', lineStart: 10, lineEnd: 10,
          title: 'Missing authorization check',
          evidence: [{ source: 'diff', file: 'src/api.ts', lineStart: 10, lineEnd: 10, content: 'return secret', explanation: 'Endpoint returns protected data.' }],
          reason: 'The endpoint has no authorization guard.', suggestedFix: 'Add an authorization check.',
        }],
      }),
    }
  }
}

test('PRGuard memory records reviews and deduplicates findings by stable fingerprint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-memory-'))
  try {
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    await memory.recordReview(snapshot, review())
    await memory.recordReview(snapshot, { ...review(finding('different-id', 0.9)), reviewId: 'review-2', createdAt: '2026-09-02T00:01:00.000Z' })
    assert.equal((await memory.manager.episodic.list(memory.manager.projectId)).length, 2)
    const semanticMemories = await memory.manager.semantic.list(memory.manager.projectId)
    const findings = semanticMemories.filter(item => item.id.startsWith('finding-'))
    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.metadata?.reviewId, 'review-2')
    assert.equal(findings[0]?.id, `finding-${findingMemoryKey(finding())}`)
    const consolidated = semanticMemories.find(item => item.provenance?.generatedBy === 'semantic-consolidation')
    assert.equal(consolidated?.metadata?.consolidatedCount, 2)
    assert.equal(consolidated?.provenance?.sourceMemoryIds?.length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('human rejection suppresses the same finding in a later review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-feedback-'))
  try {
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    await memory.recordFindingDecision(review(), 'finding-1', 'rejected', 'Known false positive')
    const adjusted = await memory.applyHistoricalFeedback(review(finding('new-model-id')))
    assert.equal(adjusted.findings.length, 0)
    assert.equal(adjusted.summary.totalFindings, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('patch verification and failures are stored with secrets redacted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-patch-memory-'))
  try {
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    const patch: Patch = { status: 'pending', summary: 'Fix auth token=secret-value', unifiedDiff: 'diff', files: ['src/api.ts'], findingIds: ['finding-1'] }
    await memory.recordPatch(patch, 'review-1', { patch: { ...patch, status: 'rolled_back' }, verification: { status: 'failed', command: 'npm test', output: 'api_key=top-secret failed' } })
    await memory.recordFailure(snapshot, 'review', new Error('Bearer abcdefghijklmnopqrstuvwxyz'))
    const records = await memory.manager.episodic.list(memory.manager.projectId)
    assert.equal(records.length, 2)
    assert.equal(records.some(record => record.content.includes('top-secret')), false)
    assert.equal(records.some(record => record.content.includes('abcdefghijklmnopqrstuvwxyz')), false)
    assert.match(redactMemoryText('password=hunter2'), /\[REDACTED\]/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('archived PRGuard memory is no longer returned by active memory queries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-archive-'))
  try {
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    await memory.recordReview(snapshot, review())
    const id = `finding-${findingMemoryKey(finding())}`
    assert.equal(await memory.archive('semantic', id, '2026-09-02T01:00:00.000Z'), true)
    assert.equal((await memory.manager.semantic.list(memory.manager.projectId, '2026-09-02T01:00:00.000Z')).length, 0)
    assert.equal(await memory.archive('semantic', 'missing-id'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('PRGuard memory enforces the configured project access policy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-memory-access-'))
  try {
    const checked: string[] = []
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir, {
      authorize: (projectId, action) => {
        checked.push(`${projectId}:${action}`)
        if (action === 'feedback') throw new Error('Memory access denied')
      },
    })
    await memory.retrieveForReview(snapshot)
    await assert.rejects(
      memory.recordFindingDecision(review(), 'finding-1', 'accepted'),
      /Memory access denied/,
    )
    assert.ok(checked.some(entry => entry.endsWith(':read')))
    assert.ok(checked.some(entry => entry.endsWith(':feedback')))
    assert.ok(checked.every(entry => entry.startsWith(`${memory.manager.projectId}:`)))
    assert.equal((await memory.manager.feedback.list(memory.manager.projectId)).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a later ReviewService run retrieves prior findings and applies human rejection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-memory-loop-'))
  try {
    const model = new RepeatedFindingModel()
    const service = new ReviewService(runtime, new NoopReviewPersistence(), dir)
    const first = await service.review(snapshot, { model })
    assert.equal(first.findings.length, 1)

    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    await memory.recordFindingDecision(first, first.findings[0]!.id, 'rejected', 'Confirmed false positive')

    const traceDir = path.join(dir, 'traces')
    const trace = await createPrGuardTrace(snapshot.input, { baseDir: traceDir, runId: 'memory-review' })
    const second = await service.review(snapshot, { model, trace })
    await trace.flush()
    assert.equal(second.findings.length, 0)
    assert.equal(second.summary.totalFindings, 0)
    const secondCallSystemText = model.calls[1]!
      .filter(message => message.role === 'system')
      .map(message => message.role === 'system' ? message.content : '')
      .join('\n')
    assert.match(secondCallSystemText, /<long-term-memory>/)
    assert.match(secondCallSystemText, /Missing authorization check/)
    assert.match(secondCallSystemText, /Human rejected finding/)
    const memoryEvent = (await loadPrGuardTrace('memory-review', traceDir))
      .find(event => event.type === 'memory_retrieved')
    assert.ok(memoryEvent)
    assert.ok(Array.isArray(memoryEvent.payload.memories))
    assert.ok((memoryEvent.payload.memories as unknown[]).length > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('repair approval automatically becomes accepted finding feedback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-approval-memory-'))
  try {
    const service = new RepairService(runtime, new NoopReviewPersistence(), dir)
    await service.recordFindingDecisions(
      snapshot.input.cwd,
      review(),
      ['finding-1'],
      'accepted',
      'Patch approved',
    )
    const memory = new PrGuardMemoryService(snapshot.input.cwd, dir)
    const feedback = await memory.manager.feedback.list(memory.manager.projectId)
    assert.equal(feedback.length, 1)
    assert.equal(feedback[0]?.metadata.decision, 'accepted')
    assert.equal(feedback[0]?.metadata.findingKey, findingMemoryKey(finding()))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
