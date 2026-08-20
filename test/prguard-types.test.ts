import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findingSchema,
  reviewInputSchema,
  reviewResultSchema,
} from '../src/prguard/types.js'

describe('PRGuard v0.1 schemas', () => {
  it('accepts a review input from a local git ref', () => {
    const result = reviewInputSchema.safeParse({
      cwd: 'D:/workspace/demo',
      baseRef: 'HEAD~1',
      headRef: 'HEAD',
    })

    assert.equal(result.success, true)
  })

  it('rejects a review input without a diff source', () => {
    const result = reviewInputSchema.safeParse({
      cwd: 'D:/workspace/demo',
    })

    assert.equal(result.success, false)
  })

  it('requires evidence for every finding', () => {
    const result = findingSchema.safeParse({
      id: 'finding-001',
      category: 'security',
      severity: 'high',
      confidence: 0.9,
      file: 'src/auth.ts',
      lineStart: 42,
      lineEnd: 45,
      title: 'Unsafe command construction',
      evidence: [],
      reason: 'User input reaches a shell command.',
      suggestedFix: 'Use an argument array and validate the input.',
      verification: {
        status: 'pending',
        commands: ['npm test'],
      },
    })

    assert.equal(result.success, false)
  })

  it('accepts a complete structured review result', () => {
    const result = reviewResultSchema.safeParse({
      schemaVersion: '0.1',
      reviewId: 'review-001',
      createdAt: '2026-08-18T12:00:00.000Z',
      input: {
        cwd: 'D:/workspace/demo',
        diffText: 'diff --git a/src/auth.ts b/src/auth.ts',
      },
      findings: [{
        id: 'finding-001',
        category: 'security',
        severity: 'high',
        confidence: 0.92,
        status: 'open',
        file: 'src/auth.ts',
        lineStart: 42,
        lineEnd: 45,
        title: 'Unsafe command construction',
        evidence: [{
          source: 'diff',
          file: 'src/auth.ts',
          lineStart: 42,
          lineEnd: 45,
          content: 'exec(`git show ${input}`)',
          explanation: 'User input is interpolated into a shell command.',
        }],
        reason: 'User-controlled input reaches command execution.',
        suggestedFix: 'Use a safe argument-based API and validate the input.',
        verification: {
          status: 'pending',
          commands: ['npm test'],
        },
      }],
      summary: {
        totalFindings: 1,
        bySeverity: { low: 0, medium: 0, high: 1, critical: 0 },
        byCategory: { security: 1, reliability: 0, code_quality: 0 },
      },
    })

    assert.equal(result.success, true)
  })
})

