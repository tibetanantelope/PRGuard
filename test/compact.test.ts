import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, AgentStep, ModelAdapter } from '../src/types.js'
import { compactConversation, groupMessagesByApiRound, findRetentionBoundary, messagesToText } from '../src/compact/compact.js'
import { THRESHOLDS, RETENTION, LIMITS } from '../src/compact/constants.js'
import { parseSummaryFromResponse, buildCompactSummaryPrompt } from '../src/compact/prompt.js'

// Mock ModelAdapter that returns a canned summary
function createMockModelAdapter(response: string): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      return { type: 'assistant', content: response }
    },
  }
}

function makeConversation(messageCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
  ]
  for (let i = 0; i < messageCount; i++) {
    messages.push({ role: 'user', content: `User message ${i}: please help me with task ${i}` })
    messages.push({ role: 'assistant', content: `Assistant response ${i}: I will help you with task ${i}. Let me read the file first.` })
    messages.push({
      role: 'assistant_tool_call',
      toolUseId: `call-${i}`,
      toolName: 'read_file',
      input: { path: `/file${i}.ts` },
    })
    messages.push({
      role: 'tool_result',
      toolUseId: `call-${i}`,
      toolName: 'read_file',
      content: `export function hello${i}() { return "world"; }`,
      isError: false,
    })
  }
  return messages
}

describe('compactConversation', () => {
  it('returns null for too few messages', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hi' },
    ]
    const adapter = createMockModelAdapter('<summary>Summary</summary>')
    const result = await compactConversation(messages, adapter)
    assert.equal(result, null)
  })

  it('compresses a long conversation successfully', async () => {
    const messages = makeConversation(10) // 41 messages
    const adapter = createMockModelAdapter(
      '<analysis>Drafting summary</analysis><summary>## Summary\nUser asked for help with 10 tasks.\nAll tasks completed.</summary>',
    )
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    assert.ok(result!.removedCount > 0, `should remove messages, removed ${result!.removedCount}`)
    assert.ok(result!.messages.length < messages.length, 'result should have fewer messages')
    assert.ok(result!.tokensAfter < result!.tokensBefore, 'tokens should decrease')
    assert.equal(result!.summary.role, 'context_summary')
    assert.ok(result!.summary.content.length > 0)
    assert.ok(result!.summary.compressedCount > 0)
  })

  it('preserves system messages', async () => {
    const messages = makeConversation(8)
    const adapter = createMockModelAdapter('<summary>Summary</summary>')
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    const systemMsgs = result!.messages.filter(m => m.role === 'system')
    assert.equal(systemMsgs.length, 1)
    assert.equal(systemMsgs[0].content, 'You are a helpful assistant.')
  })

  it('preserves recent messages', async () => {
    const messages = makeConversation(8)
    const lastUserMsg = messages[messages.length - 2] // last user message
    const lastAssistantMsg = messages[messages.length - 1] // last assistant message
    const adapter = createMockModelAdapter('<summary>Summary</summary>')
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    assert.ok(result!.messages.includes(lastUserMsg), 'last user message should be preserved')
    assert.ok(result!.messages.includes(lastAssistantMsg), 'last assistant message should be preserved')
  })

  it('includes context_summary in result', async () => {
    const messages = makeConversation(10)
    const adapter = createMockModelAdapter('<summary>Detailed summary here</summary>')
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    const summaries = result!.messages.filter(m => m.role === 'context_summary')
    assert.equal(summaries.length, 1, 'should have exactly one context_summary')
    assert.equal(summaries[0].content, 'Detailed summary here')
  })

  it('returns null when adapter returns empty response', async () => {
    const messages = makeConversation(10)
    const adapter = createMockModelAdapter('')
    const result = await compactConversation(messages, adapter)
    assert.equal(result, null)
  })

  it('returns null when adapter throws', async () => {
    const messages = makeConversation(10)
    const adapter: ModelAdapter = {
      async next() { throw new Error('API error') },
    }
    const result = await compactConversation(messages, adapter)
    assert.equal(result, null)
  })

  it('does not split tool_use/tool_result pairs in retained messages', async () => {
    const messages = makeConversation(10)
    const adapter = createMockModelAdapter('<summary>Summary</summary>')
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    // Verify no orphaned tool_result without preceding tool_use
    // (context_summary can appear before tool_result, that's OK)
    for (let i = 0; i < result!.messages.length; i++) {
      const msg = result!.messages[i]
      if (msg.role === 'tool_result') {
        // Find the corresponding tool_use by matching toolUseId
        const matchingToolUse = result!.messages.some(
          m => m.role === 'assistant_tool_call' && m.toolUseId === msg.toolUseId,
        )
        assert.ok(matchingToolUse, `tool_result with id ${msg.toolUseId} should have a matching tool_use`)
      }
    }
  })

  it('marks retained provider usage stale after compaction', async () => {
    const messages = makeConversation(10)
    const last = messages[messages.length - 1]
    if (last.role === 'tool_result') {
      messages.splice(messages.length - 2, 0, {
        role: 'assistant',
        content: 'Recent answer with provider usage',
        providerUsage: {
          inputTokens: 10_000,
          outputTokens: 100,
          totalTokens: 10_100,
          source: 'test',
        },
      })
    }
    const adapter = createMockModelAdapter('<summary>Summary</summary>')
    const result = await compactConversation(messages, adapter)

    assert.notEqual(result, null)
    const retainedUsage = result!.messages.find(
      m => m.role === 'assistant' && m.providerUsage,
    )
    assert.ok(retainedUsage)
    assert.equal(
      retainedUsage!.role === 'assistant' ? retainedUsage!.usageStale : false,
      true,
    )
  })
})

describe('groupMessagesByApiRound', () => {
  it('groups tool_use and tool_result together', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant_tool_call', toolUseId: '1', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: '1', toolName: 'read_file', content: 'file content', isError: false },
      { role: 'assistant', content: 'Done' },
    ]
    const groups = groupMessagesByApiRound(messages)
    assert.ok(groups.length >= 2)
    // The tool_use + tool_result should be grouped together
    const toolGroup = groups.find(g => g.some(m => m.role === 'assistant_tool_call'))
    assert.ok(toolGroup)
    assert.ok(toolGroup!.some(m => m.role === 'tool_result'), 'tool_result should be in same group as tool_use')
  })

  it('groups thinking with parallel tool uses and their results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant_thinking', blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }] },
      { role: 'assistant_tool_call', toolUseId: '1', toolName: 'read_file', input: { path: 'a.ts' } },
      { role: 'assistant_tool_call', toolUseId: '2', toolName: 'read_file', input: { path: 'b.ts' } },
      { role: 'tool_result', toolUseId: '1', toolName: 'read_file', content: 'a', isError: false },
      { role: 'tool_result', toolUseId: '2', toolName: 'read_file', content: 'b', isError: false },
      { role: 'assistant', content: 'Done' },
    ]

    const groups = groupMessagesByApiRound(messages)
    const toolGroup = groups.find(g => g.some(m => m.role === 'assistant_thinking'))

    assert.ok(toolGroup)
    assert.deepEqual(toolGroup!.map(m => m.role), [
      'assistant_thinking',
      'assistant_tool_call',
      'assistant_tool_call',
      'tool_result',
      'tool_result',
    ])
  })
})

describe('findRetentionBoundary', () => {
  it('keeps at least MIN_KEEP_MESSAGES from the tail', () => {
    const messages = makeConversation(20) // 81 messages
    const boundary = findRetentionBoundary(messages)
    const retained = messages.length - boundary
    assert.ok(retained >= RETENTION.MIN_KEEP_MESSAGES, `should keep at least ${RETENTION.MIN_KEEP_MESSAGES}, kept ${retained}`)
  })

  it('keeps at most MAX_KEEP_TOKENS of messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      ...Array(100).fill(null).map((_, i) => ({
        role: 'user' as const,
        content: 'x'.repeat(5000),
      })),
    ]
    const boundary = findRetentionBoundary(messages)
    const retained = messages.slice(boundary)
    // Count estimated tokens of retained
    let tokens = 0
    for (const m of retained) {
      if (m.role === 'user') tokens += Math.ceil(m.content.length / 3.0)
    }
    assert.ok(tokens <= RETENTION.MAX_KEEP_TOKENS + 5000, `retained tokens should be near MAX_KEEP_TOKENS, got ${tokens}`)
  })
})

describe('parseSummaryFromResponse', () => {
  it('extracts content from <summary> tags', () => {
    const response = '<analysis>thinking...</analysis><summary>The user asked for help.</summary>'
    assert.equal(parseSummaryFromResponse(response), 'The user asked for help.')
  })

  it('extracts content from <summary> tags with multiline', () => {
    const response = '<analysis>draft</analysis><summary>\n## Summary\n\n- Point 1\n- Point 2\n</summary>'
    const result = parseSummaryFromResponse(response)
    assert.ok(result!.includes('## Summary'))
    assert.ok(result!.includes('Point 1'))
  })

  it('returns raw text if no <summary> or <analysis> tags', () => {
    const response = 'Just a plain summary without tags.'
    assert.equal(parseSummaryFromResponse(response), 'Just a plain summary without tags.')
  })

  it('returns null for <analysis> only without <summary>', () => {
    const response = '<analysis>Just thinking, no summary</analysis>'
    assert.equal(parseSummaryFromResponse(response), null)
  })

  it('returns null for empty string', () => {
    assert.equal(parseSummaryFromResponse(''), null)
  })
})

describe('buildCompactSummaryPrompt', () => {
  it('includes conversation text in prompt', () => {
    const prompt = buildCompactSummaryPrompt('User asked for X')
    assert.ok(prompt.includes('User asked for X'))
    assert.ok(prompt.includes('<summary>'))
    assert.ok(prompt.includes('<analysis>'))
  })
})
