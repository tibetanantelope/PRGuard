import test from 'node:test'
import assert from 'node:assert/strict'
import { PrGuardMetrics } from '../src/prguard/observability.js'

test('prometheus metrics aggregate counters, durations, and trace usage', () => {
  const metrics = new PrGuardMetrics()
  metrics.increment('example_total', { status: 'ok' })
  metrics.increment('example_total', { status: 'ok' }, 2)
  metrics.observe('example_duration_ms', 12, { route: '/healthz' })
  metrics.recordTrace([
    {
      runId: 'run-1', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z', type: 'model_response',
      payload: { usage: { inputTokens: 10, outputTokens: 4 }, durationMs: 20 },
    },
    {
      runId: 'run-1', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_finished',
      payload: { toolName: 'read_file', ok: true, durationMs: 3 },
    },
  ])
  const output = metrics.renderPrometheus()
  assert.match(output, /example_total\{status="ok"\} 3/)
  assert.match(output, /prguard_model_tokens_total\{direction="input"\} 10/)
  assert.match(output, /prguard_tool_calls_total\{tool="read_file",status="success"\} 1/)
  assert.match(output, /prguard_model_request_duration_ms_sum 20/)
})
