import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvaluationService, TraceService } from '../src/prguard/services.js'

describe('PRGuard services', () => {
  it('persists and replays traces through TraceService', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'prguard-services-'))
    try {
      const service = new TraceService(baseDir)
      const trace = await service.create({ cwd: 'D:/demo', diffText: 'diff' })
      await trace.record('review_completed', { result: { findings: [] } })
      await trace.record('run_finished', { status: 'review_completed' })
      await trace.flush()

      const events = await service.load(trace.runId)
      const summaries = await service.list()
      assert.equal(events.length, 3)
      assert.equal(summaries[0]?.runId, trace.runId)
      assert.match(service.replay(events), /review_completed/)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('runs offline evaluation through EvaluationService', async () => {
    const report = await new EvaluationService().evaluate({
      datasetPath: path.resolve('evals/tasks.jsonl'),
      source: 'baseline',
    })
    assert.equal(report.source, 'baseline')
    assert.ok(report.metrics.findingF1 >= 0)
  })
})
