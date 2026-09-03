import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import {
  addPendingAction,
  CheckpointManager,
  CheckpointStore,
  createRuntimeState,
  ToolExecutionLedger,
  WorkingMemoryStore,
  resumeAgentTurn,
} from '../src/runtime/index.js'
import { ToolRegistry, type ToolDefinition, type ToolRisk } from '../src/tool.js'
import type { ChatMessage } from '../src/types.js'

async function harness(risk: ToolRisk, ledgerStatus: 'completed' | 'started') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-ledger-recovery-'))
  const checkpoints = new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') })
  const memory = new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') })
  const manager = new CheckpointManager(checkpoints, memory)
  const ledger = new ToolExecutionLedger(path.join(dir, 'ledger'))
  const state = createRuntimeState('recover tool execution', 'task-ledger')
  state.run.phase = 'executing'
  const actionKey = `${state.run.runId}:tool:call-1`
  state.workingMemory = addPendingAction(state.workingMemory, {
    kind: 'tool_call', description: 'recoverable_tool execution', idempotencyKey: actionKey,
    callId: 'call-1', toolName: 'recoverable_tool', toolInput: { value: 'input' }, toolRisk: risk,
  })
  const messages: ChatMessage[] = [
    { role: 'user', content: 'recover it' },
    { role: 'assistant_tool_call', toolUseId: 'call-1', toolName: 'recoverable_tool', input: { value: 'input' } },
  ]
  await manager.commit({ state, messagesSnapshot: messages, inputHash: 'same-input', idempotencyKey: 'crash-checkpoint' })
  const started = await ledger.start({
    runId: state.run.runId, idempotencyKey: actionKey, callId: 'call-1', toolName: 'recoverable_tool', risk, input: { value: 'input' },
  })
  if (ledgerStatus === 'completed') await ledger.complete(started, { ok: true, output: 'persisted-result' })
  return { dir, manager, memory, ledger, state }
}

function registry(risk: ToolRisk, run: () => void): ToolRegistry {
  const tool: ToolDefinition<{ value: string }> = {
    name: 'recoverable_tool', description: 'test tool', inputSchema: { type: 'object' },
    schema: z.object({ value: z.string() }), risk,
    async run() { run(); return { ok: true, output: 'replayed-result' } },
  }
  return new ToolRegistry([tool])
}

test('recovery reuses a completed tool result without executing the tool again', async () => {
  const h = await harness('state_changing', 'completed')
  let executions = 0
  try {
    const result = await resumeAgentTurn({
      model: { async next(messages) {
        assert.ok(messages.some(message => message.role === 'tool_result' && message.content === 'persisted-result'))
        return { type: 'assistant', content: 'resumed' }
      } },
      tools: registry('state_changing', () => { executions += 1 }), messages: [], cwd: h.dir,
      checkpointManager: h.manager, workingMemoryStore: h.memory, executionLedger: h.ledger,
      runId: h.state.run.runId, expectedInputHash: 'same-input',
    })
    assert.equal(executions, 0)
    assert.equal(result.at(-1)?.role, 'assistant')
  } finally { await rm(h.dir, { recursive: true, force: true }) }
})

test('recovery never replays an indeterminate state-changing tool', async () => {
  const h = await harness('state_changing', 'started')
  let executions = 0
  try {
    await resumeAgentTurn({
      model: { async next(messages) {
        const recovered = messages.find(message => message.role === 'tool_result')
        assert.match(recovered?.role === 'tool_result' ? recovered.content : '', /was not replayed/)
        return { type: 'assistant', content: 'manual reconciliation required' }
      } },
      tools: registry('state_changing', () => { executions += 1 }), messages: [], cwd: h.dir,
      checkpointManager: h.manager, workingMemoryStore: h.memory, executionLedger: h.ledger,
      runId: h.state.run.runId,
    })
    assert.equal(executions, 0)
  } finally { await rm(h.dir, { recursive: true, force: true }) }
})

test('recovery safely retries an incomplete read-only tool', async () => {
  const h = await harness('read_only', 'started')
  let executions = 0
  try {
    await resumeAgentTurn({
      model: { async next(messages) {
        assert.ok(messages.some(message => message.role === 'tool_result' && message.content === 'replayed-result'))
        return { type: 'assistant', content: 'done' }
      } },
      tools: registry('read_only', () => { executions += 1 }), messages: [], cwd: h.dir,
      checkpointManager: h.manager, workingMemoryStore: h.memory, executionLedger: h.ledger,
      runId: h.state.run.runId,
    })
    assert.equal(executions, 1)
  } finally { await rm(h.dir, { recursive: true, force: true }) }
})
