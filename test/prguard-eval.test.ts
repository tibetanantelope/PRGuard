import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateEvalMetrics, compareEvalReports, evaluateDataset, evaluateGate, loadEvalDataset, summarizeEvalDataset, type EvalReport } from '../src/prguard/eval.js'

function report(findingF1: number, highRiskRecall: number | null, taskFailureRate: number): EvalReport {
  return {
    dataset: 'evals/tasks.jsonl', source: 'predictions',
    metrics: {
      taskCount: 1, failedTaskCount: 0, expectedFindingCount: 1, predictedFindingCount: 1,
      matchedFindingCount: 1, findingPrecision: findingF1, findingRecall: findingF1,
      findingF1, localizationAccuracy: findingF1, highRiskRecall, patchTestPassRate: null,
      repairTaskCount: 0, patchGenerationSuccessRate: null, patchApplySuccessRate: null,
      rollbackVerificationRate: null, endToEndRepairSuccessRate: null,
      averageToolCalls: 1, averageTokens: 2, averageDurationMs: 3, taskFailureRate,
      adaptiveTaskCount: 0, adaptiveEscalatedTaskCount: 0, adaptiveEscalationRate: null,
      verifierTaskCount: 0, verifierInvocationRate: 0, verifierCheckedFindingCount: 0,
      verifierRejectedFindingCount: 0, fallbackTaskCount: 0, fallbackRate: 0, specialistFailureCount: 0,
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

test('evaluation gate catches metric thresholds and baseline regressions', () => {
  const result = evaluateGate(report(0.5, 0.5, 0.2), report(1, 1, 0), {
    minFindingF1: 0.6,
    maxTaskFailureRate: 0.1,
  })
  assert.equal(result.passed, false)
  assert.match(result.failures.join('\n'), /findingF1|taskFailureRate|baseline regression/)
})

test('evaluation rejects incomplete prediction files', async () => {
  await assert.rejects(
    () => evaluateDataset({
      datasetPath: 'evals/tasks.jsonl',
      source: 'predictions',
      predictions: [{ taskId: 'command-injection', findings: [] }],
    }),
    /Missing evaluation predictions/,
  )
})

test('evaluation dataset requires metadata, both splits, and one version', async () => {
  const tasks = await loadEvalDataset('evals/tasks.jsonl')
  const summary = summarizeEvalDataset(tasks)
  assert.equal(summary.datasetVersion, 'v2')
  assert.equal(summary.taskCount, 57)
  assert.equal(summary.validationTaskCount, 37)
  assert.equal(summary.holdoutTaskCount, 20)
  assert.equal(summary.repairTaskCount, 5)
  assert.deepEqual(summary.categoryCounts, { security: 36, reliability: 18, code_quality: 7 })
})

test('evaluation metrics calculate repair pipeline success rates separately', () => {
  const expected = new Map([['repair', [{ category: 'security' as const, severity: 'high' as const, file: 'a.ts', lineStart: 1, lineEnd: 1, title: 'risk' }]]])
  const result = calculateEvalMetrics(expected, [{
    taskId: 'repair',
    findings: [{ category: 'security', severity: 'high', file: 'a.ts', lineStart: 1, lineEnd: 1 }],
    repairAttempted: true,
    patchGenerated: true,
    patchApplied: true,
    patchTestPassed: true,
    rollbackVerified: true,
    endToEndRepairSuccess: true,
  }])
  assert.equal(result.metrics.repairTaskCount, 1)
  assert.equal(result.metrics.patchGenerationSuccessRate, 1)
  assert.equal(result.metrics.patchApplySuccessRate, 1)
  assert.equal(result.metrics.rollbackVerificationRate, 1)
  assert.equal(result.metrics.endToEndRepairSuccessRate, 1)
})

test('evaluation metrics expose strategy-level execution telemetry', () => {
  const expected = new Map([
    ['adaptive', [{ category: 'security' as const, severity: 'high' as const, file: 'a.ts', lineStart: 1, lineEnd: 1, title: 'risk' }]],
    ['multi', []],
  ])
  const result = calculateEvalMetrics(expected, [
    {
      taskId: 'adaptive', findings: [], adaptiveEscalated: true, verifierInvoked: true,
      verifierCheckedFindingCount: 2, verifierRejectedFindingCount: 1, fallbackUsed: false,
      specialistCount: 3, specialistFailureCount: 1,
    },
    {
      taskId: 'multi', findings: [], fallbackUsed: true, specialistCount: 3, specialistFailureCount: 3,
    },
  ])
  assert.equal(result.metrics.adaptiveTaskCount, 1)
  assert.equal(result.metrics.adaptiveEscalatedTaskCount, 1)
  assert.equal(result.metrics.adaptiveEscalationRate, 1)
  assert.equal(result.metrics.verifierTaskCount, 1)
  assert.equal(result.metrics.verifierInvocationRate, 0.5)
  assert.equal(result.metrics.verifierCheckedFindingCount, 2)
  assert.equal(result.metrics.verifierRejectedFindingCount, 1)
  assert.equal(result.metrics.fallbackTaskCount, 1)
  assert.equal(result.metrics.fallbackRate, 0.5)
  assert.equal(result.metrics.specialistFailureCount, 4)
})
