import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateEvalMetrics, compareEvalReports, type EvalReport } from '../src/prguard/eval.js'

function report(findingF1: number, highRiskRecall: number | null, taskFailureRate: number): EvalReport {
  return {
    dataset: 'evals/tasks.jsonl', source: 'predictions',
    metrics: {
      taskCount: 1, failedTaskCount: 0, expectedFindingCount: 1, predictedFindingCount: 1,
      matchedFindingCount: 1, findingPrecision: findingF1, findingRecall: findingF1,
      findingF1, localizationAccuracy: findingF1, highRiskRecall, patchTestPassRate: null,
      averageToolCalls: 1, averageTokens: 2, averageDurationMs: 3, taskFailureRate,
      falsePositiveCount: 0, falseNegativeCount: 0,
    }, matches: [],
  }
}

test('evaluation comparison reports regressions against baseline', () => {
  const comparison = compareEvalReports(report(0.5, 0.5, 0.2), report(1, 1, 0))
  assert.deepEqual(comparison.regressions, ['findingF1', 'highRiskRecall', 'taskFailureRate'])
  assert.equal(comparison.delta.findingF1, -0.5)
})

test('evaluation metrics expose false positives and negatives', () => {
  const expected = new Map([['task-1', [{ category: 'security' as const, severity: 'high' as const, file: 'a.ts', lineStart: 1, lineEnd: 1, title: 'risk' }]]])
  const result = calculateEvalMetrics(expected, [{ taskId: 'task-1', findings: [] }])
  assert.equal(result.metrics.falsePositiveCount, 0)
  assert.equal(result.metrics.falseNegativeCount, 1)
})
