import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateEvalMetrics,
  evaluateDataset,
  runRuleBaseline,
} from '../src/prguard/index.js'
import type { EvalExpectedFinding } from '../src/prguard/eval.js'

describe('PRGuard offline evaluation', () => {
  it('detects the representative command injection fixture', () => {
    const findings = runRuleBaseline(`
diff --git a/src/runner.ts b/src/runner.ts
--- a/src/runner.ts
+++ b/src/runner.ts
@@ -1,1 +1,2 @@
+export function run(input: string) { return exec(input); }
`.trim())

    assert.equal(findings.length, 1)
    assert.equal(findings[0]?.category, 'security')
    assert.equal(findings[0]?.lineStart, 1)
  })

  it('calculates precision, recall, F1 and high-risk recall', () => {
    const expected: EvalExpectedFinding = {
      category: 'security',
      severity: 'high',
      file: 'src/auth.ts',
      lineStart: 10,
      lineEnd: 10,
      title: 'Missing authorization',
    }
    const result = calculateEvalMetrics(
      new Map([['task-1', [expected]]]),
      [{
        taskId: 'task-1',
        findings: [{
          category: 'security',
          severity: 'high',
          file: 'src/auth.ts',
          lineStart: 11,
          lineEnd: 11,
          title: 'Possible missing authorization',
        }],
        patchTestPassed: true,
      }],
    )

    assert.equal(result.metrics.findingPrecision, 1)
    assert.equal(result.metrics.findingRecall, 1)
    assert.equal(result.metrics.findingF1, 1)
    assert.equal(result.metrics.highRiskRecall, 1)
    assert.equal(result.metrics.patchTestPassRate, 1)
  })

  it('evaluates the checked-in baseline dataset', async () => {
    const report = await evaluateDataset({
      datasetPath: 'evals/tasks.jsonl',
      source: 'baseline',
    })

    assert.equal(report.metrics.taskCount, 6)
    assert.equal(report.metrics.expectedFindingCount, 5)
    assert.equal(report.metrics.findingRecall, 1)
    assert.equal(report.metrics.highRiskRecall, 1)
    assert.equal(report.metrics.taskFailureRate, 0)
  })
})
