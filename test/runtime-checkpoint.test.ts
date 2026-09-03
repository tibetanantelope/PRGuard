import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  addPlanStep,
  CheckpointManager,
  CheckpointStore,
  createRuntimeState,
  WorkingMemoryStore,
  resumeAgentTurn,
} from '../src/runtime/index.js'
import { ToolRegistry } from '../src/tool.js'

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'minicode-runtime-'))
}

test('working memory store saves immutable revisions and loads the latest valid record', async () => {
  const dir = await makeDir()
  try {
    const store = new WorkingMemoryStore({ baseDir: dir })
    const state = createRuntimeState('goal', 'task-1', '2026-09-02T00:00:00.000Z')
    await store.save(state.run.runId, state.workingMemory)
    await store.save(state.run.runId, addPlanStep(state.workingMemory, 'inspect'), 2)
    const latest = await store.load(state.run.runId)
    assert.equal(latest?.revision, 2)
    assert.equal(latest?.memory.plan[0]?.description, 'inspect')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoint manager commits, deduplicates, and recovers the latest state', async () => {
  const dir = await makeDir()
  try {
    const manager = new CheckpointManager(
      new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') }),
      new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') }),
    )
    const state = createRuntimeState('goal', 'task-1', '2026-09-02T00:00:00.000Z')
    const first = await manager.commit({ state, inputHash: 'input-1', idempotencyKey: 'phase-1', now: '2026-09-02T00:01:00.000Z' })
    const duplicate = await manager.commit({ state, inputHash: 'input-1', idempotencyKey: 'phase-1', now: '2026-09-02T00:02:00.000Z' })
    assert.equal(duplicate.checkpointId, first.checkpointId)
    const nextState = { ...state, run: { ...state.run, phase: 'planning' as const }, workingMemory: addPlanStep(state.workingMemory, 'inspect') }
    const second = await manager.commit({ state: nextState, inputHash: 'input-1', idempotencyKey: 'phase-2' })
    assert.equal(second.version, 2)
    assert.equal((await manager.recover(state.run.runId, 'input-1'))?.run.phase, 'planning')
    await assert.rejects(() => manager.recover(state.run.runId, 'input-2'), /input hash mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoint recovery ignores partial and corrupted files', async () => {
  const dir = await makeDir()
  try {
    const store = new CheckpointStore({ baseDir: dir })
    const state = createRuntimeState('goal', 'task-1', '2026-09-02T00:00:00.000Z')
    const manager = new CheckpointManager(store, new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') }))
    await manager.commit({ state, idempotencyKey: 'phase-1' })
    const runDir = path.join(dir, state.run.runId)
    await writeFile(path.join(runDir, 'checkpoint-999-corrupt.json'), '{not-json', 'utf8')
    await writeFile(path.join(runDir, 'checkpoint-1000-partial.json.partial'), '{not-json', 'utf8')
    assert.equal((await manager.latest(state.run.runId))?.version, 1)
    const files = await readdir(runDir)
    const checkpointFile = files.find(file => file.endsWith('.json'))!
    assert.ok((await readFile(path.join(runDir, checkpointFile), 'utf8')).includes('phase'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoint manager finds the latest run for a session reference', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-checkpoint-session-'))
  try {
    const checkpoints = new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') })
    const memory = new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') })
    const manager = new CheckpointManager(checkpoints, memory)
    const state = createRuntimeState('resume me', 'task-1', '2026-09-02T00:00:00.000Z')
    await manager.commit({ state, messagesRef: 'session:s-1', now: '2026-09-02T00:00:00.000Z' })
    const completed = createRuntimeState('already done', 'task-2', '2026-09-02T00:01:00.000Z')
    completed.run.phase = 'completed'
    completed.run.status = 'completed'
    await manager.commit({ state: completed, messagesRef: 'session:s-1', now: '2026-09-02T00:01:00.000Z' })
    assert.equal((await manager.latestForMessagesRef('session:s-1'))?.taskId, 'task-2')
    assert.equal((await manager.latestResumableForMessagesRef('session:s-1'))?.taskId, 'task-1')
    assert.equal(await manager.latestForMessagesRef('session:s-2'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resumeAgentTurn restores the checkpoint and continues execution', async () => {
  const dir = await makeDir()
  try {
    const checkpoints = new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') })
    const memory = new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') })
    const manager = new CheckpointManager(checkpoints, memory)
    const state = createRuntimeState('continue task', 'task-resume')
    await manager.commit({ state, messagesRef: 'session:resume' })
    const result = await resumeAgentTurn({
      model: { async next() { return { type: 'assistant', content: 'continued' } } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'continue task' }],
      cwd: process.cwd(),
      checkpointManager: manager,
      workingMemoryStore: memory,
      runId: state.run.runId,
    })
    assert.equal(result.at(-1)?.role, 'assistant')
    assert.equal(result.at(-1)?.role === 'assistant' ? result.at(-1)?.content : '', 'continued')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('end-to-end recovery continues after a model interruption', async () => {
  const dir = await makeDir()
  try {
    const checkpoints = new CheckpointStore({ baseDir: path.join(dir, 'checkpoints') })
    const memory = new WorkingMemoryStore({ baseDir: path.join(dir, 'memory') })
    const manager = new CheckpointManager(checkpoints, memory)
    const state = createRuntimeState('recover interrupted work', 'task-e2e')
    let attempts = 0
    await manager.commit({ state, messagesRef: 'session:e2e' })
    await assert.rejects(() => resumeAgentTurn({
      model: { async next() { attempts += 1; throw new Error('temporary provider failure') } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'recover interrupted work' }],
      cwd: process.cwd(),
      checkpointManager: manager,
      workingMemoryStore: memory,
      runId: state.run.runId,
    }), /temporary provider failure/)
    const recovered = await manager.latest(state.run.runId)
    assert.equal(recovered?.phase, 'failed')

    const result = await resumeAgentTurn({
      model: { async next() { attempts += 1; return { type: 'assistant', content: 'recovered successfully' } } },
      tools: new ToolRegistry([]),
      messages: [{ role: 'user', content: 'recover interrupted work' }],
      cwd: process.cwd(),
      checkpointManager: manager,
      workingMemoryStore: memory,
      runId: state.run.runId,
    })
    assert.equal(attempts, 2)
    assert.equal(result.at(-1)?.role, 'assistant')
    assert.equal((await manager.latest(state.run.runId))?.phase, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
