import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { SubAgentManager } from '../src/agents/manager.js'
import { MAX_SUB_AGENTS } from '../src/agents/types.js'
import { ToolRegistry, type ToolDefinition } from '../src/tool.js'
import { SUB_AGENT_TOOL_NAMES } from '../src/tools/index.js'
import { createSubAgentTools } from '../src/tools/sub-agents.js'
import type {
  AgentStep,
  ChatMessage,
  ModelAdapter,
  ModelRequestOptions,
} from '../src/types.js'

function testTool(name: string): ToolDefinition<Record<string, never>> {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    schema: z.object({}),
    async run() {
      return { ok: true, output: name }
    },
  }
}

describe('SubAgentManager', () => {
  it('exposes the four root orchestration tools', async () => {
    const model: ModelAdapter = {
      async next(): Promise<AgentStep> {
        return { type: 'assistant', content: 'worker report' }
      },
    }
    const manager = new SubAgentManager({
      model,
      tools: new ToolRegistry([]),
      cwd: process.cwd(),
    })
    const tools = new ToolRegistry(createSubAgentTools(manager))

    assert.deepEqual(
      tools.list().map(tool => tool.name),
      ['spawn_agent', 'list_agents', 'wait_agent', 'close_agent'],
    )
    const spawned = await tools.execute(
      'spawn_agent',
      { task: 'inspect the parser' },
      { cwd: process.cwd() },
    )
    assert.equal(spawned.ok, true)
    const spawnedOutput = JSON.parse(spawned.output) as {
      agent: { id: string }
    }
    const waited = await tools.execute(
      'wait_agent',
      { agent_ids: [spawnedOutput.agent.id] },
      { cwd: process.cwd() },
    )
    const waitedOutput = JSON.parse(waited.output) as {
      agents: Array<Record<string, unknown>>
    }

    assert.equal(waited.ok, true)
    assert.deepEqual(waitedOutput.agents, [{
      id: spawnedOutput.agent.id,
      task: 'inspect the parser',
      status: 'completed',
      result: 'worker report',
    }])
  })

  it('runs at most three isolated workers with only the read-only tool set', async () => {
    const requests: Array<{
      messages: ChatMessage[]
      options?: ModelRequestOptions
    }> = []
    const model: ModelAdapter = {
      async next(messages, options): Promise<AgentStep> {
        requests.push({ messages, options })
        const task = messages.findLast(message => message.role === 'user')
        return {
          type: 'assistant',
          content: task?.role === 'user' ? `report: ${task.content}` : 'report',
        }
      },
    }
    const rootTools = new ToolRegistry([
      ...SUB_AGENT_TOOL_NAMES.map(testTool),
      testTool('write_file'),
      testTool('run_command'),
      testTool('spawn_agent'),
    ])
    const manager = new SubAgentManager({
      model,
      tools: rootTools.subset(SUB_AGENT_TOOL_NAMES),
      cwd: process.cwd(),
    })

    const agents = ['one', 'two', 'three'].map(task => manager.spawn(task))
    assert.equal(manager.runningCount, MAX_SUB_AGENTS)
    assert.throws(
      () => manager.spawn('four'),
      /At most 3 sub-agents/,
    )

    const result = await manager.wait(agents.map(agent => agent.id))
    assert.equal(result.timedOut, false)
    assert.deepEqual(
      result.agents.map(agent => agent.status),
      ['completed', 'completed', 'completed'],
    )
    assert.deepEqual(
      result.agents.map(agent => agent.result),
      ['report: one', 'report: two', 'report: three'],
    )
    assert.equal(requests.length, 3)

    const expectedTools = [...SUB_AGENT_TOOL_NAMES]
    for (const request of requests) {
      assert.equal(
        request.messages.filter(message => message.role === 'user').length,
        1,
      )
      assert.deepEqual(
        request.options?.tools?.map(tool => tool.name),
        expectedTools,
      )
      assert.equal(
        request.options?.tools?.some(tool =>
          ['write_file', 'run_command', 'spawn_agent'].includes(tool.name)
        ),
        false,
      )
    }
  })

  it('closes a running worker by aborting its model request', async () => {
    let requestSignal: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const model: ModelAdapter = {
      async next(_messages, options): Promise<AgentStep> {
        requestSignal = options?.signal
        markStarted?.()
        return await new Promise<AgentStep>((_resolve, reject) => {
          const rejectForAbort = () => reject(
            requestSignal?.reason ?? new Error('aborted'),
          )
          if (requestSignal?.aborted) {
            rejectForAbort()
            return
          }
          requestSignal?.addEventListener('abort', rejectForAbort, { once: true })
        })
      },
    }
    const manager = new SubAgentManager({
      model,
      tools: new ToolRegistry([]),
      cwd: process.cwd(),
    })
    const agent = manager.spawn('keep looking forever')

    await started
    const closed = await manager.close(agent.id)

    assert.equal(requestSignal?.aborted, true)
    assert.equal(closed.status, 'closed')
    assert.ok(closed.finishedAt)
    assert.equal(manager.runningCount, 0)
  })

  it('returns current state on wait timeout without closing the worker', async () => {
    const model: ModelAdapter = {
      async next(_messages, options): Promise<AgentStep> {
        return await new Promise<AgentStep>((_resolve, reject) => {
          const signal = options?.signal
          const rejectForAbort = () => reject(
            signal?.reason ?? new Error('aborted'),
          )
          if (signal?.aborted) {
            rejectForAbort()
            return
          }
          signal?.addEventListener('abort', rejectForAbort, { once: true })
        })
      },
    }
    const manager = new SubAgentManager({
      model,
      tools: new ToolRegistry([]),
      cwd: process.cwd(),
    })
    const agent = manager.spawn('slow task')

    const result = await manager.wait([agent.id], 1)

    assert.equal(result.timedOut, true)
    assert.equal(result.agents[0]?.status, 'running')
    await manager.close(agent.id)
  })
})
