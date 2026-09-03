import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OrchestrationBudgetController,
  OrchestrationBudgetExceededError,
  ReviewBlackboard,
  routePrGuardSpecialists,
  runReviewJudge,
} from '../src/orchestration/index.js'
import type { Finding, PrDiffSnapshot, ReviewResult } from '../src/prguard/types.js'

function snapshot(path: string, diffText: string): PrDiffSnapshot {
  return {
    input: { cwd: 'D:/workspace/demo', diffText },
    diffText,
    changedFiles: [{ path, status: 'modified', additions: 3, deletions: 1, hunks: [] }],
    repository: { root: 'D:/workspace/demo', projectFiles: [], instructionFiles: [] },
  }
}

function finding(id: string, category: Finding['category'], severity: Finding['severity'], confidence: number, fix: string): Finding {
  return {
    id, category, severity, confidence, status: 'open', file: 'src/api.ts', lineStart: 10, lineEnd: 10,
    title: `${category} issue`, reason: `${category} risk`, suggestedFix: fix,
    evidence: [{ source: 'diff', file: 'src/api.ts', lineStart: 10, lineEnd: 10, content: 'return secret', explanation: 'Changed line.' }],
    verification: { status: 'pending', commands: [], passedCommands: [], failedCommands: [] },
    provenance: { sourceAgents: [`${category}-agent`], supportCount: 1, aggregationReason: 'single specialist' },
  }
}

test('dynamic router selects only experts justified by the diff', () => {
  const docs = routePrGuardSpecialists(snapshot('README.md', 'diff --git a/README.md b/README.md\n+Document the public API response.'))
  assert.deepEqual(docs.selected.map(role => role.name), ['Code Quality Agent'])

  const reliability = routePrGuardSpecialists(snapshot('src/worker.ts', 'diff --git a/src/worker.ts b/src/worker.ts\n+await retryWithBackoff(job, { timeout: 5000 });'))
  assert.deepEqual(reliability.selected.map(role => role.name), ['Reliability Agent', 'Code Quality Agent'])

  const security = routePrGuardSpecialists(snapshot('src/auth.ts', 'diff --git a/src/auth.ts b/src/auth.ts\n+return user.secret; // authorization required'))
  assert.deepEqual(security.selected.map(role => role.name), ['Security Agent', 'Code Quality Agent'])
})

test('shared orchestration budget enforces model calls, tokens, and concurrency', async () => {
  const budget = new OrchestrationBudgetController({
    maxModelCalls: 1, maxInputTokens: 20, maxOutputTokens: 10, maxDurationMs: 10_000, maxConcurrentAgents: 1,
  })
  const release = budget.enterAgent()
  assert.throws(() => budget.enterAgent(), OrchestrationBudgetExceededError)
  release()
  const model = budget.wrap({ async next() {
    return { type: 'assistant' as const, content: 'ok', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: 'test' } }
  } })
  await model.next([])
  await assert.rejects(model.next([]), /Model-call budget exceeded/)
  const usage = budget.snapshot()
  assert.equal(usage.modelCalls, 1)
  assert.equal(usage.inputTokens, 4)
  assert.equal(usage.outputTokens, 2)
  assert.equal(usage.activeAgents, 0)
  assert.equal(usage.peakConcurrentAgents, 1)
  assert.equal(usage.remainingModelCalls, 0)
})

test('blackboard exposes conflicts and model Critic/Judge arbitrates them', async () => {
  const currentSnapshot = snapshot('src/api.ts', 'diff --git a/src/api.ts b/src/api.ts\n+return secret')
  const security = finding('finding-1', 'security', 'high', 0.9, 'Require authorization.')
  const quality = finding('finding-2', 'code_quality', 'medium', 0.7, 'Rename the method.')
  const result: ReviewResult = {
    schemaVersion: '0.1', reviewId: 'review-1', createdAt: '2026-09-03T00:00:00.000Z', input: currentSnapshot.input,
    findings: [security, quality],
    summary: {
      totalFindings: 2,
      bySeverity: { low: 0, medium: 1, high: 1, critical: 0 },
      byCategory: { security: 1, reliability: 0, code_quality: 1 },
    },
  }
  const blackboard = new ReviewBlackboard()
  blackboard.recordFindings('Security Agent', [security])
  blackboard.recordFindings('Code Quality Agent', [quality])
  assert.equal(blackboard.conflicts().length, 1)
  const judged = await runReviewJudge({
    snapshot: currentSnapshot,
    result,
    blackboard,
    unsupportedFindingIds: ['finding-1', 'finding-2'],
    model: { async next() {
      return {
        type: 'assistant',
        content: JSON.stringify({ verdicts: [
          { findingId: 'finding-1', decision: 'accepted', reason: 'Evidence supports an authorization defect.' },
          { findingId: 'finding-2', decision: 'rejected', reason: 'Superseded by the security finding.' },
        ] }),
      }
    } },
  })
  assert.equal(judged.mode, 'model')
  assert.deepEqual(judged.rejectedFindingIds, ['finding-2'])
  assert.deepEqual(judged.result.findings.map(item => item.id), ['finding-1'])
  assert.equal(blackboard.snapshot().judgments.length, 2)
})
