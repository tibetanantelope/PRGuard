import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateAgentReviews,
  runAdaptivePrReview,
  buildPrReviewSystemPrompt,
  runMultiAgentPrReview,
  verifyReviewEvidence,
  verifyReviewEvidenceSelective,
} from '../src/prguard/index.js'
import type { PrDiffSnapshot, ReviewResult } from '../src/prguard/types.js'
import type { ModelAdapter } from '../src/types.js'
import type { RuntimeConfig } from '../src/config.js'

const snapshot: PrDiffSnapshot = {
  input: { cwd: 'D:/workspace/demo', diffText: 'diff' },
  diffText: 'diff',
  changedFiles: [{
    path: 'src/auth.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    hunks: [],
  }],
  repository: {
    root: 'D:/workspace/demo',
    projectFiles: ['package.json'],
    instructionFiles: [],
  },
}

const runtime = {
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1',
  mcpServers: {},
  sourceSummary: 'test',
  prGuardReviewTimeoutMs: 100,
} as RuntimeConfig

function emptyReviewModel(failuresBeforeSuccess = 0): ModelAdapter {
  let calls = 0
  return {
    async next() {
      calls += 1
      if (calls <= failuresBeforeSuccess) throw new Error('transient model failure')
      return { type: 'assistant', content: '{"findings":[]}' }
    },
  }
}

function review(id: string, confidence: number, category: 'security' | 'reliability' | 'code_quality' = 'security'): ReviewResult {
  return {
    schemaVersion: '0.1',
    reviewId: id,
    createdAt: '2026-08-19T00:00:00.000Z',
    input: snapshot.input,
    findings: [{
      id,
      category,
      severity: 'high',
      confidence,
      status: 'open',
      file: 'src/auth.ts',
      lineStart: 10,
      lineEnd: 10,
      title: 'Missing authorization check',
      evidence: [{
        source: 'diff',
        file: 'src/auth.ts',
        lineStart: 10,
        lineEnd: 10,
        content: 'return user.secret',
        explanation: 'The changed endpoint returns a protected field.',
      }],
      reason: 'The endpoint does not check access before returning protected data.',
      suggestedFix: 'Require authorization before reading the resource.',
      verification: { status: 'pending', commands: [] },
    }],
    summary: {
      totalFindings: 1,
      bySeverity: { low: 0, medium: 0, high: 1, critical: 0 },
      byCategory: { security: category === 'security' ? 1 : 0, reliability: category === 'reliability' ? 1 : 0, code_quality: category === 'code_quality' ? 1 : 0 },
    },
  }
}

describe('PRGuard multi-agent review', () => {
  it('adds specialist focus and skill instructions to the prompt', () => {
    const prompt = buildPrReviewSystemPrompt({
      role: 'Security Agent',
      skillName: 'prguard-security',
      focus: 'authorization and injection',
    })
    assert.match(prompt, /Security Agent/)
    assert.match(prompt, /prguard-security/)
    assert.match(prompt, /authorization and injection/)
  })

  it('deduplicates corroborated findings and raises confidence', () => {
    const result = aggregateAgentReviews(
      snapshot,
      [review('security-finding', 0.7), review('quality-finding', 0.8)],
      [
        { role: 'Security Reviewer', findingCount: 1 },
        { role: 'Security Agent', findingCount: 1 },
      ],
    )

    assert.equal(result.aggregation.inputFindingCount, 2)
    assert.equal(result.aggregation.deduplicatedFindingCount, 1)
    assert.equal(result.aggregation.supportedFindingCount, 1)
    assert.equal(result.findings[0]?.confidence, 0.9)
    assert.equal(result.findings[0]?.id, 'finding-1')
  })

  it('rejects findings outside a specialist category and suppresses unsupported low-risk findings', () => {
    const mismatched = review('quality-finding', 0.95, 'code_quality')
    mismatched.findings[0]!.severity = 'medium'
    const lowConfidence = review('low-finding', 0.6)
    lowConfidence.findings[0]!.severity = 'low'
    const result = aggregateAgentReviews(
      snapshot,
      [mismatched, lowConfidence],
      [
        { role: 'Security Agent', findingCount: 1 },
        { role: 'Security Agent', findingCount: 1 },
      ],
    )

    assert.equal(result.findings.length, 0)
    assert.equal(result.aggregation.categoryRejectedFindingCount, 1)
    assert.equal(result.aggregation.categoryMismatchAcceptedFindingCount, 0)
    assert.equal(result.aggregation.suppressedFindingCount, 1)
  })

  it('preserves high-risk findings even when confidence is low or category is unexpected', () => {
    const highRisk = review('high-risk', 0.2, 'code_quality')
    const result = aggregateAgentReviews(
      snapshot,
      [highRisk],
      [{ role: 'Security Agent', findingCount: 1 }],
    )

    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0]?.severity, 'high')
    assert.equal(result.aggregation.categoryMismatchAcceptedFindingCount, 1)
    assert.equal(result.aggregation.suppressedFindingCount, 0)
  })

  it('rejects findings whose evidence is not grounded in the changed diff', () => {
    const result = verifyReviewEvidence(snapshot, review('ungrounded', 0.8))
    assert.equal(result.result.findings.length, 0)
    assert.equal(result.summary.rejectedFindingCount, 1)
    assert.deepEqual(result.summary.rejectedFindingIds, ['ungrounded'])
    assert.match(result.summary.rejectionReasons.ungrounded ?? '', /not grounded/)
  })

  it('rejects a security finding when the changed code contains a strong SQL safeguard', () => {
    const safeSnapshot: PrDiffSnapshot = {
      ...snapshot,
      diffText: "diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+db.query('SELECT * FROM users WHERE id = ?', [userId]);",
    }
    const candidate = review('safe-sql', 0.9)
    candidate.findings[0]!.title = 'SQL injection risk'
    candidate.findings[0]!.reason = 'The query is built from user input.'
    candidate.findings[0]!.evidence[0]!.content = "db.query('SELECT * FROM users WHERE id = ?', [userId]);"
    const result = verifyReviewEvidence(safeSnapshot, candidate)

    assert.equal(result.result.findings.length, 0)
    assert.equal(result.summary.rejectedFindingIds[0], 'safe-sql')
    assert.match(result.summary.rejectionReasons['safe-sql'] ?? '', /parameterized/)
  })

  it('rejects a command finding when shell execution is disabled', () => {
    const safeSnapshot: PrDiffSnapshot = {
      ...snapshot,
      diffText: "diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+execFile(command, args, { shell: false });",
    }
    const candidate = review('safe-command', 0.9)
    candidate.findings[0]!.title = 'Command injection risk'
    candidate.findings[0]!.reason = 'User input reaches command execution.'
    candidate.findings[0]!.evidence[0]!.content = 'execFile(command, args, { shell: false });'
    const result = verifyReviewEvidence(safeSnapshot, candidate)

    assert.equal(result.result.findings.length, 0)
    assert.match(result.summary.rejectionReasons['safe-command'] ?? '', /non-shell/)
  })

  it('only verifies selected findings in selective mode', () => {
    const candidate = review('selective-command', 0.9)
    candidate.findings[0]!.title = 'Command injection risk'
    candidate.findings[0]!.reason = 'User input reaches command execution.'
    candidate.findings[0]!.evidence[0]!.content = 'diff'
    const unrelated = review('unselected', 0.9)
    unrelated.findings[0]!.evidence[0]!.content = 'not in diff'
    const combined: ReviewResult = {
      ...candidate,
      findings: [candidate.findings[0]!, unrelated.findings[0]!],
      summary: { ...candidate.summary, totalFindings: 2 },
    }
    const result = verifyReviewEvidenceSelective(snapshot, combined, { findingIds: ['selective-command'] })

    assert.equal(result.summary.checkedFindingCount, 1)
    assert.equal(result.result.findings.length, 2)
    assert.equal(result.result.evidenceVerification?.checkedFindingCount, 1)
  })

  it('retries specialists independently and preserves partial success', async () => {
    const result = await runMultiAgentPrReview(snapshot, runtime, {
      model: emptyReviewModel(1),
      specialistRetries: 1,
      specialistTimeoutMs: 100,
    })

    assert.equal(result.agents.length, 3)
    assert.equal(result.agents.every(agent => agent.attempts === 1 || agent.attempts === 2), true)
    assert.equal(result.agents.filter(agent => agent.failed).length, 0)
    assert.equal(result.aggregation.fallbackUsed, false)
  })

  it('uses Single-Agent fallback when every specialist fails', async () => {
    const result = await runMultiAgentPrReview(snapshot, runtime, {
      model: emptyReviewModel(6),
      specialistRetries: 1,
      specialistTimeoutMs: 100,
    })

    assert.equal(result.aggregation.fallbackUsed, true)
    assert.equal(result.agents.filter(agent => agent.fallback).length, 1)
    assert.equal(result.agents.filter(agent => agent.failed).length, 3)
  })

  it('keeps low-risk clean changes on the Single-Agent path', async () => {
    const result = await runAdaptivePrReview(snapshot, runtime, { model: emptyReviewModel() })

    assert.equal(result.routing.escalated, false)
    assert.deepEqual(result.routing.reasons, [])
  })

  it('escalates a diff containing multiple independent risk signals', async () => {
    const riskySnapshot: PrDiffSnapshot = {
      ...snapshot,
      diffText: 'diff --git a/src/run.ts b/src/run.ts\n+++ b/src/run.ts\n+spawn(command);\n+const sql = `SELECT * FROM users WHERE id = ${id}`;',
    }
    const result = await runAdaptivePrReview(riskySnapshot, runtime, { model: emptyReviewModel() })

    assert.equal(result.routing.escalated, true)
    assert.deepEqual(result.routing.reasons, ['multi_risk_diff'])
    assert.equal(result.aggregation.fallbackUsed, false)
  })
})
