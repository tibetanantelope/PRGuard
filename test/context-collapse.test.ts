import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
  findCollapseCandidate,
  projectCollapsedView,
  type CollapseSpan,
  type ContextCollapseState,
} from '../src/compact/context-collapse.js'
import {
  CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
  CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
} from '../src/compact/constants.js'
import {
  autoCompact,
  resetAutoCompactState,
  shouldAutoCompact,
} from '../src/compact/auto-compact.js'

function withIds(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => ({
    ...message,
    id: `m-${index}`,
  }) as ChatMessage)
}

function makeAdapter(response: string, calls?: { count: number; requests: ChatMessage[][] }): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      if (calls) {
        calls.count += 1
        calls.requests.push(messages)
      }
      return { type: 'assistant', content: response }
    },
  }
}

function makeSequenceAdapter(
  responses: Array<string | Error>,
  calls?: { count: number; requests: ChatMessage[][] },
): ModelAdapter {
  return {
    async next(messages: ChatMessage[]): Promise<AgentStep> {
      if (calls) {
        calls.count += 1
        calls.requests.push(messages)
      }
      const next = responses.shift()
      if (next instanceof Error) {
        throw next
      }
      return { type: 'assistant', content: next ?? '<summary>fallback</summary>' }
    },
  }
}

function makeFailingAdapter(calls?: { count: number }): ModelAdapter {
  return {
    async next(): Promise<AgentStep> {
      if (calls) calls.count += 1
      throw new Error('summary failed')
    },
  }
}

function makeCollapsibleConversation(options: {
  oldPairs?: number
  oldSize?: number
  recentCount?: number
  trailingAfterLastUserSize?: number
} = {}): ChatMessage[] {
  const oldPairs = options.oldPairs ?? 18
  const oldSize = options.oldSize ?? 10_000
  const recentCount = options.recentCount ?? CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES
  const messages: ChatMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Opening task' },
  ]

  for (let i = 0; i < oldPairs; i++) {
    messages.push(
      { role: 'assistant', content: `Old assistant ${i}: ${'a'.repeat(oldSize)}` },
      { role: 'user', content: `Old user ${i}: ${'b'.repeat(oldSize)}` },
    )
  }

  for (let i = 0; i < recentCount - 1; i++) {
    messages.push({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `Recent ${i}`,
    } as ChatMessage)
  }
  messages.push({ role: 'user', content: 'Current active user request' })

  if (options.trailingAfterLastUserSize) {
    messages.push({
      role: 'assistant',
      content: `Protected assistant after last user: ${'z'.repeat(options.trailingAfterLastUserSize)}`,
    })
  }

  return withIds(messages)
}

function committedSpan(args: {
  messages: ChatMessage[]
  start: number
  end: number
  id?: string
  summary?: string
}): CollapseSpan {
  const selected = args.messages.slice(args.start, args.end)
  const ids = selected.map((message, offset) => message.id ?? `message-${args.start + offset}`)
  return {
    id: args.id ?? `collapse-${args.start}-${args.end}`,
    startMessageId: ids[0]!,
    endMessageId: ids[ids.length - 1]!,
    messageIds: ids,
    summary: args.summary ?? 'Older work was summarized.',
    tokensBefore: 10_000,
    tokensAfter: 200,
    status: 'committed',
    createdAt: 123,
    reason: 'context_pressure',
  }
}

function stateWithSpans(spans: CollapseSpan[]): ContextCollapseState {
  return {
    spans,
    enabled: true,
    consecutiveFailures: 0,
  }
}

describe('Context Collapse', () => {
  beforeEach(() => {
    resetAutoCompactState()
  })

  it('does not collapse below threshold', async () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
    ])
    const calls = { count: 0, requests: [] as ChatMessage[][] }
    const state = createContextCollapseState()
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>unused</summary>', calls),
      state,
    )

    assert.equal(result.collapsed, false)
    assert.strictEqual(result.messages, messages)
    assert.equal(calls.count, 0)
    assert.equal(result.state.spans.length, 0)
  })

  it('attempts collapse at or above utilization threshold', async () => {
    const messages = makeCollapsibleConversation()
    const calls = { count: 0, requests: [] as ChatMessage[][] }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>Collapsed summary with file paths and decisions.</summary>', calls),
      createContextCollapseState(),
    )

    assert.ok(calls.count >= 1)
    assert.equal(result.spans.length, calls.count)
    assert.equal(result.collapsed, true)
    assert.equal(result.span?.status, 'committed')
    assert.ok(calls.requests[0]![1]!.role === 'user')
    assert.ok(
      calls.requests[0]![1]!.role === 'user' &&
      calls.requests[0]![1]!.content.includes('Preserve:'),
    )
  })

  it('leaves messages unchanged when no safe interval exists', async () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'context_summary', content: 'Do not fold me. '.repeat(40_000), compressedCount: 3, timestamp: 1 },
      ...Array.from({ length: CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES }, (_, i) => ({
        role: i === CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES - 1 ? 'user' as const : 'assistant' as const,
        content: `Recent ${i}`,
      })),
    ] as ChatMessage[])
    const calls = { count: 0, requests: [] as ChatMessage[][] }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>unused</summary>', calls),
      createContextCollapseState(),
    )

    assert.equal(result.collapsed, false)
    assert.strictEqual(result.messages, messages)
    assert.equal(calls.count, 0)
  })

  it('makes the model-visible messages shorter while preserving originals', async () => {
    const messages = makeCollapsibleConversation()
    const before = structuredClone(messages)
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>Summarized older messages.</summary>'),
      createContextCollapseState(),
    )

    assert.equal(result.collapsed, true)
    assert.ok(result.messages.length < messages.length)
    assert.equal(messages.length, before.length)
    assert.deepEqual(messages, before)
  })

  it('does not cut tool_call and tool_result pairs', () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Opening' },
      { role: 'assistant_tool_call', toolUseId: 'read-1', toolName: 'read_file', input: { path: 'a.ts' } },
      { role: 'tool_result', toolUseId: 'read-1', toolName: 'read_file', content: 'file\n'.repeat(5_000), isError: false },
      ...Array.from({ length: CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES - 1 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: `Recent ${i}`,
      })),
      { role: 'user', content: 'Current request' },
    ] as ChatMessage[])
    const candidate = findCollapseCandidate(messages, createContextCollapseState(), {
      minTokensToSave: CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
    })

    assert.ok(candidate)
    const ids = new Set(candidate!.messageIds)
    assert.equal(ids.has('m-2'), ids.has('m-3'))
  })

  it('does not collapse the recent keep window', () => {
    const messages = makeCollapsibleConversation()
    const recentIds = new Set(
      messages.slice(-CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES).map(message => message.id),
    )
    const candidate = findCollapseCandidate(messages, createContextCollapseState())

    assert.ok(candidate)
    for (const id of candidate!.messageIds) {
      assert.equal(recentIds.has(id), false)
    }
  })

  it('does not collapse the last user message or anything after it', () => {
    const messages = makeCollapsibleConversation({
      oldPairs: 8,
      oldSize: 8_000,
      trailingAfterLastUserSize: 180_000,
    })
    const lastUserIndex = messages.findLastIndex(message => message.role === 'user')
    const protectedIds = new Set(messages.slice(lastUserIndex).map(message => message.id))
    const candidate = findCollapseCandidate(messages, createContextCollapseState())

    assert.ok(candidate)
    for (const id of candidate!.messageIds) {
      assert.equal(protectedIds.has(id), false)
    }
  })

  it('does not collapse system, context summary, or snip boundary messages', () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'context_summary', content: 'Existing compact summary', compressedCount: 10, timestamp: 1 },
      { role: 'snip_boundary', content: 'Existing snip', removedMessageIds: ['x'], removedCount: 1, tokensFreed: 3_000, timestamp: 2 },
      { role: 'user', content: 'Old safe user: ' + 'u'.repeat(8_000) },
      { role: 'assistant', content: 'Old safe assistant: ' + 'a'.repeat(8_000) },
      ...Array.from({ length: CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES - 1 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: `Recent ${i}`,
      })),
      { role: 'user', content: 'Current request' },
    ] as ChatMessage[])
    const candidate = findCollapseCandidate(messages, createContextCollapseState())

    assert.ok(candidate)
    assert.equal(candidate!.messageIds.includes('m-0'), false)
    assert.equal(candidate!.messageIds.includes('m-1'), false)
    assert.equal(candidate!.messageIds.includes('m-2'), false)
  })

  it('places the collapsed summary in the projected view', () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
    ])
    const span = committedSpan({ messages, start: 1, end: 4, summary: 'A through C summarized.' })
    const view = projectCollapsedView(messages, stateWithSpans([span]))

    assert.equal(view.length, 3)
    assert.equal(view[1]!.role, 'context_summary')
    assert.ok(view[1]!.role === 'context_summary' && view[1]!.content.includes('[Collapsed context summary]'))
    assert.ok(view[1]!.role === 'context_summary' && view[1]!.content.includes('The original transcript is preserved'))
    assert.equal(view[2]!.id, 'm-4')
  })

  it('skips illegal overlapping spans', () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
    ])
    const first = committedSpan({ messages, start: 1, end: 3, id: 'first', summary: 'First span.' })
    const overlapping = committedSpan({ messages, start: 2, end: 4, id: 'second', summary: 'Second span.' })
    const view = projectCollapsedView(messages, stateWithSpans([first, overlapping]))
    const summaries = view.filter(message => message.role === 'context_summary')

    assert.equal(summaries.length, 1)
    assert.ok(summaries[0]!.role === 'context_summary' && summaries[0]!.content.includes('First span.'))
    assert.equal(view.some(message => message.id === 'm-3'), true)
  })

  it('skips invalid spans and does not mutate original messages or state', () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
    ])
    const valid = committedSpan({ messages, start: 1, end: 3, summary: 'A and B summarized.' })
    const invalid: CollapseSpan = {
      ...valid,
      id: 'invalid-missing-id',
      startMessageId: 'missing-start',
      endMessageId: 'missing-end',
      messageIds: ['missing-start', 'missing-end'],
      summary: 'Should be skipped.',
    }
    const state = stateWithSpans([invalid, valid])
    const beforeMessages = structuredClone(messages)
    const beforeState = structuredClone(state)

    const view = projectCollapsedView(messages, state)

    assert.equal(view.length, 3)
    assert.equal(view.filter(message => message.role === 'context_summary').length, 1)
    assert.deepEqual(messages, beforeMessages)
    assert.deepEqual(state, beforeState)
  })

  it('does not select messages already covered by a committed span', () => {
    const messages = makeCollapsibleConversation({
      oldPairs: 4,
      oldSize: 20_000,
    })
    const span = committedSpan({ messages, start: 1, end: 5 })
    const candidate = findCollapseCandidate(messages, stateWithSpans([span]), {
      minTokensToSave: CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
    })

    assert.ok(candidate)
    const alreadyCollapsedIds = new Set(span.messageIds)
    for (const id of candidate!.messageIds) {
      assert.equal(alreadyCollapsedIds.has(id), false)
    }
  })

  it('does not commit a span when collapse summary generation fails', async () => {
    const messages = makeCollapsibleConversation()
    const state = createContextCollapseState()
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeFailingAdapter(),
      state,
    )

    assert.equal(result.collapsed, false)
    assert.strictEqual(result.messages, messages)
    assert.equal(state.spans.length, 0)
    assert.equal(state.consecutiveFailures, 0)
    assert.equal(result.state.spans.length, 0)
    assert.equal(result.state.consecutiveFailures, 1)
  })

  it('commits a span and resets consecutive failures after success', async () => {
    const messages = makeCollapsibleConversation()
    const state: ContextCollapseState = {
      spans: [],
      enabled: true,
      consecutiveFailures: 3,
    }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>Recovered with a good summary.</summary>'),
      state,
    )

    assert.equal(result.collapsed, true)
    assert.ok(result.state.spans.length >= 1)
    assert.ok(result.state.spans.every(span => span.status === 'committed'))
    assert.equal(result.state.consecutiveFailures, 0)
  })

  it('increments consecutive failures after failure', async () => {
    const messages = makeCollapsibleConversation()
    const state: ContextCollapseState = {
      spans: [],
      enabled: true,
      consecutiveFailures: 4,
    }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeFailingAdapter(),
      state,
    )

    assert.equal(result.collapsed, false)
    assert.equal(result.state.consecutiveFailures, 5)
  })

  it('commits multiple planned spans in one pass when target usage is still high', async () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Opening task' },
      { role: 'assistant', content: 'First old run: ' + 'a'.repeat(80_000) },
      { role: 'user', content: 'First old follow-up: ' + 'b'.repeat(80_000) },
      { role: 'context_summary', content: 'Existing boundary', compressedCount: 4, timestamp: 1 },
      { role: 'assistant', content: 'Second old run: ' + 'c'.repeat(80_000) },
      { role: 'user', content: 'Second old follow-up: ' + 'd'.repeat(80_000) },
      ...Array.from({ length: CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES - 1 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: `Recent ${i}`,
      })),
      { role: 'user', content: 'Current request' },
    ] as ChatMessage[])
    const calls = { count: 0, requests: [] as ChatMessage[][] }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeSequenceAdapter([
        '<summary>First run summary.</summary>',
        '<summary>Second run summary.</summary>',
      ], calls),
      createContextCollapseState(),
      {
        utilizationThreshold: 0,
        targetUsage: 0.10,
        maxSpansPerPass: 2,
      },
    )

    assert.equal(calls.count, 2)
    assert.equal(result.collapsed, true)
    assert.equal(result.spans.length, 2)
    assert.equal(result.state.spans.length, 2)
    assert.ok(result.state.spans.every(span => span.status === 'committed'))
    assert.equal(result.messages.filter(message => message.role === 'context_summary').length, 3)
  })

  it('does not commit staged spans if a later span summary fails', async () => {
    const messages = withIds([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Opening task' },
      { role: 'assistant', content: 'First old run: ' + 'a'.repeat(80_000) },
      { role: 'user', content: 'First old follow-up: ' + 'b'.repeat(80_000) },
      { role: 'context_summary', content: 'Existing boundary', compressedCount: 4, timestamp: 1 },
      { role: 'assistant', content: 'Second old run: ' + 'c'.repeat(80_000) },
      { role: 'user', content: 'Second old follow-up: ' + 'd'.repeat(80_000) },
      ...Array.from({ length: CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES - 1 }, (_, i) => ({
        role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
        content: `Recent ${i}`,
      })),
      { role: 'user', content: 'Current request' },
    ] as ChatMessage[])
    const calls = { count: 0, requests: [] as ChatMessage[][] }
    const result = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeSequenceAdapter([
        '<summary>First run summary.</summary>',
        new Error('second summary failed'),
      ], calls),
      createContextCollapseState(),
      {
        utilizationThreshold: 0,
        targetUsage: 0.10,
        maxSpansPerPass: 2,
      },
    )

    assert.equal(calls.count, 2)
    assert.equal(result.collapsed, false)
    assert.strictEqual(result.messages, messages)
    assert.equal(result.state.spans.length, 0)
    assert.equal(result.state.consecutiveFailures, 1)
  })

  it('disables collapse after repeated summary failures', async () => {
    const messages = makeCollapsibleConversation()
    const calls = { count: 0 }
    let state = createContextCollapseState()

    state = (await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeFailingAdapter(calls),
      state,
      { maxFailures: 2 },
    )).state
    assert.equal(state.enabled, true)

    state = (await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeFailingAdapter(calls),
      state,
      { maxFailures: 2 },
    )).state
    assert.equal(state.enabled, false)

    const disabledResult = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>Should not be called</summary>'),
      state,
      { maxFailures: 2 },
    )

    assert.equal(calls.count, 2)
    assert.equal(disabledResult.collapsed, false)
    assert.equal(disabledResult.state.enabled, false)
  })

  it('still allows Auto Compact to run when collapsed view remains above threshold', async () => {
    const messages = makeCollapsibleConversation({
      oldPairs: 4,
      oldSize: 12_000,
      trailingAfterLastUserSize: 400_000,
    })
    const collapseResult = await applyContextCollapseIfNeeded(
      messages,
      'deepseek-chat',
      makeAdapter('<summary>Small older safe range summarized.</summary>'),
      createContextCollapseState(),
    )

    assert.equal(collapseResult.collapsed, true)
    assert.equal(shouldAutoCompact(collapseResult.messages, 'deepseek-chat'), true)

    const compactResult = await autoCompact(
      collapseResult.messages,
      'deepseek-chat',
      makeAdapter('<summary>Full compact fallback summary.</summary>'),
    )

    assert.ok(compactResult)
    assert.equal(compactResult!.summary.role, 'context_summary')
  })
})
