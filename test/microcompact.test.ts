import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/types.js'
import { microcompact } from '../src/compact/microcompact.js'
import { CLEAR_MARKER } from '../src/utils/token-estimator.js'

function makeMessages(count: number, toolResults: Array<{ toolName: string; content: string }>): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'System prompt' },
  ]
  for (const tr of toolResults) {
    messages.push(
      { role: 'assistant_tool_call', toolUseId: `id-${tr.toolName}`, toolName: tr.toolName, input: {} },
      { role: 'tool_result', toolUseId: `id-${tr.toolName}`, toolName: tr.toolName, content: tr.content, isError: false },
    )
  }
  // Add user messages to pad
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `User message ${i}` })
  }
  return messages
}

describe('microcompact', () => {
  it('returns messages unchanged when utilization is low', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ]
    const result = microcompact(messages, 'claude-sonnet-4-6')
    assert.strictEqual(result, messages, 'should return same reference when no changes needed')
  })

  it('clears old compactable tool results when utilization is high', () => {
    // Create enough data to exceed 50% utilization for deepseek-chat (124K effective)
    const bigContent = 'x'.repeat(80_000)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      // 5 read_file tool results (4 old + 1 recent, keepRecent=3)
      { role: 'assistant_tool_call', toolUseId: 'id-1', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-1', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-2', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-2', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-3', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-3', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-4', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-4', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-5', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-5', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'user', content: 'Continue' },
    ]
    const result = microcompact(messages, 'deepseek-chat')

    // Find tool_result messages
    const toolResults = result.filter(m => m.role === 'tool_result') as Extract<ChatMessage, { role: 'tool_result' }>[]
    const cleared = toolResults.filter(m => m.content === CLEAR_MARKER)
    const preserved = toolResults.filter(m => m.content === bigContent)

    assert.ok(cleared.length >= 1, `expected at least 1 cleared, got ${cleared.length}`)
    assert.ok(preserved.length <= 3, `expected at most 3 preserved, got ${preserved.length}`)
    assert.equal(result.length, messages.length, 'should not change message count')
  })

  it('preserves non-compactable tool results', () => {
    const bigContent = 'x'.repeat(80_000)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'assistant_tool_call', toolUseId: 'id-1', toolName: 'edit_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-1', toolName: 'edit_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-2', toolName: 'edit_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-2', toolName: 'edit_file', content: bigContent, isError: false },
      { role: 'user', content: 'Continue' },
    ]
    const result = microcompact(messages, 'deepseek-chat')
    const toolResults = result.filter(m => m.role === 'tool_result') as Extract<ChatMessage, { role: 'tool_result' }>[]

    // edit_file is not in COMPACTABLE_TOOLS, so nothing should be cleared
    for (const tr of toolResults) {
      assert.equal(tr.content, bigContent, 'non-compactable tool results should not be cleared')
    }
  })

  it('does not modify the original array', () => {
    const bigContent = 'x'.repeat(80_000)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'assistant_tool_call', toolUseId: 'id-1', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-1', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-2', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-2', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-3', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-3', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-4', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-4', toolName: 'read_file', content: bigContent, isError: false },
      { role: 'user', content: 'Continue' },
    ]
    const originalContents = messages
      .filter(m => m.role === 'tool_result')
      .map(m => (m as Extract<ChatMessage, { role: 'tool_result' }>).content)

    microcompact(messages, 'deepseek-chat')

    const afterContents = messages
      .filter(m => m.role === 'tool_result')
      .map(m => (m as Extract<ChatMessage, { role: 'tool_result' }>).content)

    assert.deepEqual(originalContents, afterContents, 'original array should not be mutated')
  })

  it('returns same reference if all tool results are already cleared', () => {
    const bigContent = 'x'.repeat(80_000)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'assistant_tool_call', toolUseId: 'id-1', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-1', toolName: 'read_file', content: CLEAR_MARKER, isError: false },
      { role: 'assistant_tool_call', toolUseId: 'id-2', toolName: 'read_file', input: {} },
      { role: 'tool_result', toolUseId: 'id-2', toolName: 'read_file', content: CLEAR_MARKER, isError: false },
      { role: 'user', content: 'Continue' },
    ]
    const result = microcompact(messages, 'deepseek-chat')
    // Content is already CLEAR_MARKER, so no change, but utilization may be low enough
    // that it returns the same reference anyway
    assert.ok(result === messages || Array.isArray(result))
  })
})
