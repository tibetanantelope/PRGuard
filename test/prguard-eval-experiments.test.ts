import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPrGuardEvaluation } from '../src/prguard/eval-experiments.js'

test('rule baseline uses the same experiment runner and writes a holdout report', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-eval-rule-'))
  const result = await runPrGuardEvaluation({
    datasetPath: 'evals/tasks.jsonl',
    outputDir,
    mode: 'rule-baseline',
    split: 'holdout',
    runId: 'rule-holdout-001',
  })

  assert.equal(result.manifest.mode, 'rule-baseline')
  assert.equal(result.manifest.split, 'holdout')
  assert.equal(result.manifest.taskCount, 20)
  assert.equal(result.report.metrics.taskCount, 20)
  assert.equal(result.manifest.failedTaskIds.length, 0)
  assert.equal(JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8')).runId, 'rule-holdout-001')
})

test('agent experiment modes require runtime configuration', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-eval-agent-'))
  await assert.rejects(
    () => runPrGuardEvaluation({
      datasetPath: 'evals/tasks.jsonl',
      outputDir,
      mode: 'single-agent',
    }),
    /Runtime configuration is required/,
  )
})
