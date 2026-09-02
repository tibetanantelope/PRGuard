import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runEvaluationExperiment } from '../src/prguard/eval-runner.js'

test('evaluation runner records metadata, task telemetry, failures, and artifacts', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-eval-run-'))
  const result = await runEvaluationExperiment({
    datasetPath: 'evals/tasks.jsonl',
    outputDir,
    mode: 'mock-agent',
    model: 'test-model',
    promptVersion: 'review-v1',
    split: 'holdout',
    runId: 'run-test-001',
    runner: async task => task.id === 'clean-change'
      ? { findings: [], toolCalls: 2, tokens: 120 }
      : { findings: [], toolCalls: 1, tokens: 80 },
  })

  assert.equal(result.manifest.runId, 'run-test-001')
  assert.equal(result.manifest.datasetVersion, 'v2')
  assert.equal(result.manifest.split, 'holdout')
  assert.equal(result.manifest.taskCount, 20)
  assert.deepEqual(result.manifest.failedTaskIds, [])
  assert.equal(result.predictions.length, 20)
  assert.equal(result.predictions[0]?.model, 'test-model')
  assert.equal(result.predictions[0]?.promptVersion, 'review-v1')
  assert.equal(result.report.metrics.taskCount, 20)
  assert.equal(result.report.metrics.failedTaskCount, 0)
  assert.equal(JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8')).runId, 'run-test-001')
  assert.equal((await readFile(path.join(outputDir, 'predictions.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 20)
  assert.equal((await readFile(path.join(outputDir, 'report.json'), 'utf8')).length > 0, true)
})

test('evaluation runner converts task exceptions into failed predictions', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-eval-run-fail-'))
  const result = await runEvaluationExperiment({
    datasetPath: 'evals/tasks.jsonl',
    outputDir,
    mode: 'mock-agent',
    model: 'test-model',
    promptVersion: 'review-v1',
    split: 'holdout',
    runner: async () => { throw new Error('provider unavailable') },
  })

  assert.equal(result.manifest.failedTaskIds.length, 20)
  assert.equal(result.report.metrics.taskFailureRate, 1)
  assert.match(result.predictions[0]?.failureReason ?? '', /provider unavailable/)
})
