import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { runAgentTurn } from '../src/agent-loop.js'
import { ToolRegistry } from '../src/tool.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ChatMessage } from '../src/types.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Anthropic thinking block round trip', () => {
  it('preserves thinking blocks when continuing after tool results', async () => {
    const requests: unknown[] = []
    let callCount = 0

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')))
      callCount += 1

      if (callCount === 1) {
        return new Response(JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect the workspace before answering.',
              signature: 'opaque-signature',
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'echo_tool',
              input: { value: 'ok' },
            },
          ],
        }), { status: 200 })
      }

      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<final>done' }],
      }), { status: 200 })
    }) as typeof fetch

    const tools = new ToolRegistry([
      {
        name: 'echo_tool',
        description: 'Echoes a test value.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        schema: z.object({ value: z.string() }),
        async run(input) {
          return { ok: true, output: input.value }
        },
      },
    ])
    const runtime: RuntimeConfig = {
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authToken: 'test-token',
      mcpServers: {},
      sourceSummary: 'test',
    }
    const adapter = new AnthropicModelAdapter(tools, async () => runtime)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Summarize this project' },
    ]

    await runAgentTurn({
      model: adapter,
      tools,
      messages,
      cwd: process.cwd(),
    })

    assert.equal(requests.length, 2)
    const secondRequest = requests[1] as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    const assistantWithToolUse = secondRequest.messages.find(message =>
      message.role === 'assistant' &&
      message.content.some(block => block.type === 'tool_use')
    )

    assert.ok(assistantWithToolUse)
    assert.deepEqual(
      assistantWithToolUse.content.map(block => block.type),
      ['thinking', 'tool_use'],
    )
    assert.deepEqual(assistantWithToolUse.content[0], {
      type: 'thinking',
      thinking: 'I should inspect the workspace before answering.',
      signature: 'opaque-signature',
    })
  })

  it('keeps parallel tool uses in the same assistant message with their thinking block', async () => {
    const requests: unknown[] = []
    let callCount = 0

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')))
      callCount += 1

      if (callCount === 1) {
        return new Response(JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'thinking',
              thinking: 'I need two independent facts.',
              signature: 'parallel-signature',
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'echo_tool',
              input: { value: 'one' },
            },
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'echo_tool',
              input: { value: 'two' },
            },
          ],
        }), { status: 200 })
      }

      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<final>done' }],
      }), { status: 200 })
    }) as typeof fetch

    const tools = createEchoTools()
    const adapter = new AnthropicModelAdapter(tools, async () => createRuntime())

    await runAgentTurn({
      model: adapter,
      tools,
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Use two tools' },
      ],
      cwd: process.cwd(),
    })

    const secondRequest = requests[1] as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    const assistantMessages = secondRequest.messages.filter(message => message.role === 'assistant')
    const toolResultMessages = secondRequest.messages.filter(message => message.role === 'user' &&
      message.content.some(block => block.type === 'tool_result'))

    assert.equal(assistantMessages.length, 1)
    assert.deepEqual(
      assistantMessages[0]!.content.map(block => block.type),
      ['thinking', 'tool_use', 'tool_use'],
    )
    assert.deepEqual(
      toolResultMessages[0]!.content.map(block => block.tool_use_id),
      ['toolu_1', 'toolu_2'],
    )
  })

  it('preserves final assistant thinking blocks for the next user prompt', async () => {
    const requests: unknown[] = []
    let callCount = 0

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')))
      callCount += 1

      if (callCount === 1) {
        return new Response(JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'thinking',
              thinking: 'I need to inspect a fact first.',
              signature: 'tool-thinking-signature',
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'echo_tool',
              input: { value: 'one' },
            },
          ],
        }), { status: 200 })
      }

      if (callCount === 2) {
        return new Response(JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'thinking',
              thinking: 'I have the tool result and can answer.',
              signature: 'final-thinking-signature',
            },
            { type: 'text', text: '<final>done' },
          ],
        }), { status: 200 })
      }

      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<final>continued' }],
      }), { status: 200 })
    }) as typeof fetch

    const tools = createEchoTools()
    const adapter = new AnthropicModelAdapter(tools, async () => createRuntime())
    const firstTurn = await runAgentTurn({
      model: adapter,
      tools,
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Use a tool then answer' },
      ],
      cwd: process.cwd(),
    })

    await adapter.next([
      ...firstTurn,
      { role: 'user', content: 'Continue from the answer' },
    ])

    const thirdRequest = requests[2] as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    const finalAssistant = thirdRequest.messages.find(message =>
      message.role === 'assistant' &&
      message.content.some(block => block.type === 'text' && block.text === 'done')
    )

    assert.ok(finalAssistant)
    assert.deepEqual(
      finalAssistant.content.map(block => block.type),
      ['thinking', 'text'],
    )
    assert.deepEqual(finalAssistant.content[0], {
      type: 'thinking',
      thinking: 'I have the tool result and can answer.',
      signature: 'final-thinking-signature',
    })
  })
})

function createRuntime(): RuntimeConfig {
  return {
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'test-token',
    mcpServers: {},
    sourceSummary: 'test',
  }
}

function createEchoTools(): ToolRegistry {
  return new ToolRegistry([
    {
      name: 'echo_tool',
      description: 'Echoes a test value.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      schema: z.object({ value: z.string() }),
      async run(input) {
        return { ok: true, output: input.value }
      },
    },
  ])
}
