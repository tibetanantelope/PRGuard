import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'
import { runAgentTurn } from '../src/agent-loop.js'
import { tokenCountWithEstimation } from '../src/utils/token-estimator.js'
import { ToolRegistry } from '../src/tool.js'

describe('provider usage ingestion', () => {
  it('stores provider usage from assistant responses for accounting', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ]
    const adapter: ModelAdapter = {
      async next(): Promise<AgentStep> {
        return {
          type: 'assistant',
          content: 'Hi',
          usage: {
            inputTokens: 42,
            outputTokens: 8,
            totalTokens: 50,
            source: 'test',
          },
        }
      },
    }

    const result = await runAgentTurn({
      model: adapter,
      tools: new ToolRegistry([]),
      messages,
      cwd: process.cwd(),
    })
    const accounting = tokenCountWithEstimation(result)

    assert.equal(result.at(-1)?.role, 'assistant')
    assert.equal(result.at(-1)?.role === 'assistant' ? result.at(-1)?.providerUsage?.totalTokens : 0, 50)
    assert.equal(accounting.source, 'provider_usage')
    assert.equal(accounting.totalTokens, 50)
  })
})
