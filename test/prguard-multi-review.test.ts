import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateAgentReviews,
  buildPrReviewSystemPrompt,
} from '../src/prguard/index.js'
import type { PrDiffSnapshot, ReviewResult } from '../src/prguard/types.js'

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

function review(id: string, confidence: number): ReviewResult {
  return {
    schemaVersion: '0.1',
    reviewId: id,
    createdAt: '2026-08-19T00:00:00.000Z',
    input: snapshot.input,
    findings: [{
      id,
      category: 'security',
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
      byCategory: { security: 1, reliability: 0, code_quality: 0 },
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
        { role: 'Security Agent', findingCount: 1 },
        { role: 'Code Quality Agent', findingCount: 1 },
      ],
    )

    assert.equal(result.aggregation.inputFindingCount, 2)
    assert.equal(result.aggregation.deduplicatedFindingCount, 1)
    assert.equal(result.aggregation.supportedFindingCount, 1)
    assert.equal(result.findings[0]?.confidence, 0.9)
    assert.equal(result.findings[0]?.id, 'finding-1')
  })
})
