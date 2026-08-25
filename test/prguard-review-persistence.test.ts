import test from 'node:test'
import assert from 'node:assert/strict'
import { NoopReviewPersistence } from '../src/prguard/review-persistence.js'

test('noop review persistence is safe when MySQL is not configured', async () => {
  const persistence = new NoopReviewPersistence()
  await persistence.saveReview({
    snapshot: {
      input: { cwd: 'C:/repo', diffText: 'diff --git a/a b/a\n' },
      diffText: 'diff --git a/a b/a\n',
      changedFiles: [],
      repository: { root: 'C:/repo', projectFiles: [], instructionFiles: [] },
    },
    result: {
      schemaVersion: '0.1',
      reviewId: 'review-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      input: { cwd: 'C:/repo', diffText: 'diff --git a/a b/a\n' },
      findings: [],
      summary: {
        totalFindings: 0,
        bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        byCategory: { security: 0, reliability: 0, code_quality: 0 },
      },
    },
  })
  await persistence.savePatch('review-1', {
    status: 'pending', summary: 'patch', unifiedDiff: 'diff', files: ['a'], findingIds: ['f1'],
  })
  await persistence.saveTrace([])
  assert.ok(true)
})
