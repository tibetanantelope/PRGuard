import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRuntimeTrace, loadRuntimeTrace } from '../src/runtime/index.js'

test('runtime trace persists ordered redacted telemetry events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-runtime-trace-'))
  try {
    const trace = await createRuntimeTrace('run-1', dir)
    await trace.record('model_started', { messageCount: 3 })
    await trace.record('tool_finished', { toolName: 'read_file', ok: true })
    await trace.flush()
    const events = await loadRuntimeTrace('run-1', dir)
    assert.deepEqual(events.map(event => event.sequence), [0, 1, 2])
    assert.equal(events[1]?.type, 'model_started')
    assert.equal(events[2]?.payload.toolName, 'read_file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
