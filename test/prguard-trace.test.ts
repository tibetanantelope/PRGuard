import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPrGuardTrace,
  listPrGuardTraces,
  loadPrGuardTrace,
  replayPrGuardTrace,
} from '../src/prguard/trace.js'

describe('PRGuard trace', () => {
  it('writes ordered JSONL events and replays them', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'minicode-prguard-trace-'))
    try {
      const trace = await createPrGuardTrace({
        cwd: 'D:/workspace/demo',
        diffText: 'diff',
      }, { baseDir, runId: 'trace-001' })
      await trace.record('checkpoint', { phase: 'review_started' })
      await trace.record('review_completed', {
        findingCount: 1,
        result: { summary: 'api_key=trace-secret', token: 'field-secret' },
      })
      await trace.record('run_finished', { status: 'review_completed' })
      await trace.flush()

      const events = await loadPrGuardTrace('trace-001', baseDir)
      assert.deepEqual(events.map(event => event.sequence), [0, 1, 2, 3])
      assert.equal(events[0]?.payload.input?.hasInlineDiff, true)
      assert.match(replayPrGuardTrace(events), /review_completed/)
      assert.doesNotMatch(JSON.stringify(events), /trace-secret|field-secret/)

      const summaries = await listPrGuardTraces(baseDir)
      assert.equal(summaries.length, 1)
      assert.equal(summaries[0]?.status, 'review_completed')
      assert.equal(summaries[0]?.eventCount, 4)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})
