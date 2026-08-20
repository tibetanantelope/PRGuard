import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { RuntimeConfig } from '../src/config.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function runtime(): RuntimeConfig {
  return {
    model: 'test-model',
    baseUrl: 'https://example.test',
    authToken: 'test-token',
    mcpServers: {},
    sourceSummary: 'test',
  }
}

describe('model request options', () => {
  it('uses the per-request tool list instead of the adapter default', async () => {
    let requestBody: {
      tools?: Array<{ name: string }>
    } = {}
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<final>done' }],
      }), { status: 200 })
    }) as typeof fetch
    const adapter = new AnthropicModelAdapter(
      new ToolRegistry([]),
      async () => runtime(),
    )

    await adapter.next(
      [{ role: 'user', content: 'hello' }],
      {
        tools: [{
          name: 'read_only_tool',
          description: 'Read only',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    )

    assert.deepEqual(requestBody.tools?.map(tool => tool.name), ['read_only_tool'])
  })

  it('passes AbortSignal through to fetch', async () => {
    let fetchSignal: AbortSignal | null | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal
      markStarted?.()
      return await new Promise<Response>((_resolve, reject) => {
        const rejectForAbort = () => reject(new Error('fetch aborted'))
        if (fetchSignal?.aborted) {
          rejectForAbort()
          return
        }
        fetchSignal?.addEventListener('abort', rejectForAbort, { once: true })
      })
    }) as typeof fetch
    const adapter = new AnthropicModelAdapter(
      new ToolRegistry([]),
      async () => runtime(),
    )
    const controller = new AbortController()
    const request = adapter.next(
      [{ role: 'user', content: 'hello' }],
      { signal: controller.signal },
    )

    await started
    controller.abort(new Error('closed'))

    await assert.rejects(request, /fetch aborted/)
    assert.equal(fetchSignal, controller.signal)
  })
})
