import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import {
  addFact,
  addPendingAction,
  addPlanStep,
  createRuntimeState,
  hashJson,
  transitionRun,
  canTransition,
  CheckpointManager,
  CheckpointStore,
  WorkingMemoryStore,
  ToolExecutionLedger,
} from '../src/runtime/index.js'
import { runAgentTurn } from '../src/agent-loop.js'
import { ToolRegistry } from '../src/tool.js'

test('runtime state creates a structured run and working memory', () => {
  const state = createRuntimeState('Review this pull request', 'task-1', '2026-09-02T00:00:00.000Z')
  assert.equal(state.run.phase, 'input_loaded')
  assert.equal(state.run.status, 'running')
  assert.equal(state.run.taskId, 'task-1')
  assert.equal(state.workingMemory.goal, 'Review this pull request')
})

test('state machine allows valid transitions and rejects invalid transitions', () => {
  const state = createRuntimeState('goal', 'task-1', '2026-09-02T00:00:00.000Z')
  const planned = transitionRun(state.run, 'planning', '2026-09-02T00:01:00.000Z')
  const completed = transitionRun(planned, 'executing', '2026-09-02T00:02:00.000Z')
  assert.equal(completed.status, 'running')
  assert.equal(canTransition('planning', 'executing'), true)
  assert.equal(canTransition('completed', 'planning'), false)
  assert.throws(() => transitionRun(completed, 'publishing'), /Invalid Agent phase transition/)
})

test('working memory updates are immutable and deduplicate facts/actions', () => {
  const state = createRuntimeState('goal', 'task-1', '2026-09-02T00:00:00.000Z')
  const withStep = addPlanStep(state.workingMemory, 'Inspect the diff', 'step-1')
  const withFact = addFact(withStep, {
    key: 'branch', value: 'main', source: 'git', confidence: 1, observedAt: '2026-09-02T00:00:00.000Z',
  })
  const replacedFact = addFact(withFact, {
    key: 'branch', value: 'feature', source: 'git', confidence: 1, observedAt: '2026-09-02T00:01:00.000Z',
  })
  const withAction = addPendingAction(replacedFact, {
    kind: 'tool_call', description: 'Read diff', idempotencyKey: 'read-diff-1',
  })
  const deduplicated = addPendingAction(withAction, {
    kind: 'tool_call', description: 'Read diff again', idempotencyKey: 'read-diff-1',
  })
  assert.equal(state.workingMemory.plan.length, 0)
  assert.equal(withStep.plan.length, 1)
  assert.equal(replacedFact.discoveredFacts.length, 1)
  assert.equal(replacedFact.discoveredFacts[0]?.value, 'feature')
  assert.equal(deduplicated.pendingActions.length, 1)
  assert.notEqual(hashJson(state), hashJson(deduplicated))
})

test('executing can finish directly when no tools are needed', () => {
  assert.equal(canTransition('executing', 'completed'), true)
})

test('agent loop advances runtime phases and checkpoints final state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-agent-runtime-'))
  try {
    const state = createRuntimeState('Answer the task', 'task-1', '2026-09-02T00:00:00.000Z')
    const manager = new CheckpointManager(
      new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') }),
      new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') }),
    )
    const phases: string[] = []
    const model = {
      async next(messages: Array<{ role: string }>) {
        assert.equal(messages[0]?.role, 'system')
        return { type: 'assistant' as const, content: 'done' }
      },
    }
    await runAgentTurn({
      model,
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'Do it' }],
      cwd: dir,
      runtimeState: state,
      checkpointManager: manager,
      runtimeInputHash: 'input-1',
      onRuntimeState: next => phases.push(next.run.phase),
    })
    assert.deepEqual([...new Set(phases)], ['planning', 'executing', 'completed'])
    const latest = await manager.latest(state.run.runId)
    assert.equal(latest?.phase, 'completed')
    assert.equal(latest?.state.workingMemory.goal, 'Answer the task')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent loop enforces model-call budget and checkpoints failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-agent-budget-'))
  try {
    const state = createRuntimeState('Budgeted task', 'task-budget', '2026-09-02T00:00:00.000Z')
    state.run.budget = { maxModelCalls: 0 }
    const manager = new CheckpointManager(
      new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') }),
      new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') }),
    )
    await assert.rejects(() => runAgentTurn({
      model: { async next() { return { type: 'assistant' as const, content: 'never called' } } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'Do it' }],
      cwd: dir,
      runtimeState: state,
      checkpointManager: manager,
    }), /budget exceeded/)
    const latest = await manager.latest(state.run.runId)
    assert.equal(latest?.phase, 'failed')
    assert.equal(latest?.state.run.usage.modelCalls, 0)
    assert.equal(latest?.state.workingMemory.recentErrors.length, 1)
    assert.ok(latest?.state.workingMemory.plan.some(step => step.status === 'failed'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('model-call budget allows exactly the configured number of calls', async () => {
  const state = createRuntimeState('One call task', 'task-one-call')
  state.run.budget = { maxModelCalls: 1 }
  const messages = await runAgentTurn({
    model: { async next() { return { type: 'assistant' as const, content: 'done', usage: { inputTokens: 10, outputTokens: 2 } } } },
    tools: new ToolRegistry([]),
    messages: [{ role: 'user', content: 'Answer once' }],
    cwd: process.cwd(),
    runtimeState: state,
  })
  assert.equal(messages.at(-1)?.role, 'assistant')
})

test('planner steps are activated and completed by actual tool execution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-executable-plan-'))
  try {
    const state = createRuntimeState('Implement the requested change', 'task-plan')
    let calls = 0
    let latest = state
    const tools = new ToolRegistry([{
      name: 'read_file', description: 'read', inputSchema: { type: 'object' }, schema: z.object({}),
      risk: 'read_only', async run() { return { ok: true, output: 'source' } },
    }])
    await runAgentTurn({
      model: { async next() {
        calls += 1
        return calls === 1
          ? { type: 'tool_calls', calls: [{ id: 'read-1', toolName: 'read_file', input: {} }] }
          : { type: 'assistant', content: 'finished' }
      } },
      tools, messages: [{ role: 'user', content: 'Implement it' }], cwd: dir, runtimeState: state,
      executionLedger: new ToolExecutionLedger(path.join(dir, 'ledger')),
      onRuntimeState: next => { latest = next },
    })
    assert.equal(latest.run.status, 'completed')
    assert.equal(latest.workingMemory.plan.some(step => step.status === 'pending' || step.status === 'running'), false)
    assert.equal(latest.workingMemory.plan.find(step => step.capability === 'read')?.status, 'completed')
    assert.ok(latest.workingMemory.plan.some(step => step.status === 'skipped'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
