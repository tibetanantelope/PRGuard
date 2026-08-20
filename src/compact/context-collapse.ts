import type { ChatMessage, ModelAdapter } from '../types.js'
import {
  computeContextStats,
  estimateMessagesTokens,
  markProviderUsageStale,
} from '../utils/token-estimator.js'
import {
  CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
  CONTEXT_COLLAPSE_MAX_FAILURES,
  CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS,
  CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
  CONTEXT_COLLAPSE_TARGET_USAGE,
  CONTEXT_COLLAPSE_UTILIZATION,
} from './constants.js'
import { parseSummaryFromResponse } from './prompt.js'

export type CollapseSpan = {
  id: string
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  summary: string
  tokensBefore: number
  tokensAfter: number
  status: 'staged' | 'committed'
  createdAt: number
  reason: 'context_pressure' | 'manual' | 'overflow_recovery'
}

export type ContextCollapseState = {
  spans: CollapseSpan[]
  enabled: boolean
  consecutiveFailures: number
}

export type Model = string

export type ContextCollapseOptions = {
  utilizationThreshold: number
  targetUsage: number
  keepRecentMessages: number
  minTokensToSave: number
  currentTokens?: number
  effectiveInput?: number
  maxSpansPerPass: number
  maxFailures: number
  reason: CollapseSpan['reason']
}

export type CollapseCandidate = {
  startIndex: number
  endIndex: number
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  messages: ChatMessage[]
  tokensBefore: number
  estimatedTokensAfter: number
  estimatedTokensToSave: number
}

type MessageGroup = {
  start: number
  end: number
  messages: ChatMessage[]
  tokens: number
  protected: boolean
}

export type ContextCollapseResult = {
  messages: ChatMessage[]
  state: ContextCollapseState
  collapsed: boolean
  span?: CollapseSpan
  spans: CollapseSpan[]
}

const CONTEXT_COLLAPSE_STALE_REASON =
  'conversation was context-collapsed in the model-visible projection after this provider usage was recorded'

export function createContextCollapseState(): ContextCollapseState {
  return {
    spans: [],
    enabled: true,
    consecutiveFailures: 0,
  }
}

function normalizeContextCollapseState(state: ContextCollapseState): ContextCollapseState {
  return {
    spans: [...state.spans],
    enabled: state.enabled,
    consecutiveFailures: state.consecutiveFailures,
  }
}

function withDefaultOptions(
  options: Partial<ContextCollapseOptions> = {},
): ContextCollapseOptions {
  return {
    utilizationThreshold:
      options.utilizationThreshold ?? CONTEXT_COLLAPSE_UTILIZATION,
    targetUsage: options.targetUsage ?? CONTEXT_COLLAPSE_TARGET_USAGE,
    keepRecentMessages:
      options.keepRecentMessages ?? CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
    minTokensToSave:
      options.minTokensToSave ?? CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
    currentTokens: options.currentTokens,
    effectiveInput: options.effectiveInput,
    maxSpansPerPass:
      options.maxSpansPerPass ?? CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS,
    maxFailures: options.maxFailures ?? CONTEXT_COLLAPSE_MAX_FAILURES,
    reason: options.reason ?? 'context_pressure',
  }
}

function messageId(message: ChatMessage, index: number): string {
  return message.id ?? `message-${index}`
}

function isCollapseBoundary(message: ChatMessage): boolean {
  return (
    message.role === 'system' ||
    message.role === 'context_summary' ||
    message.role === 'snip_boundary'
  )
}

function estimateCollapseSummaryTokens(tokensBefore: number): number {
  return Math.max(128, Math.ceil(tokensBefore * 0.15))
}

function buildCollapsedSummaryContent(span: CollapseSpan): string {
  return [
    '[Collapsed context summary]',
    `This summary replaces messages ${span.startMessageId} through ${span.endMessageId} in the model-visible context only.`,
    'The original transcript is preserved in the session/UI.',
    '',
    span.summary,
  ].join('\n')
}

function buildCollapsedSummaryMessage(
  span: CollapseSpan,
): Extract<ChatMessage, { role: 'context_summary' }> {
  return {
    id: `collapse-summary-${span.id}`,
    role: 'context_summary',
    content: buildCollapsedSummaryContent(span),
    compressedCount: span.messageIds.length,
    timestamp: span.createdAt,
  }
}

function projectSpan(
  messages: ChatMessage[],
  span: CollapseSpan,
): {
  start: number
  end: number
  message: Extract<ChatMessage, { role: 'context_summary' }>
} | null {
  if (span.status !== 'committed' || span.messageIds.length === 0) {
    return null
  }

  const indexById = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    indexById.set(messageId(messages[i]!, i), i)
  }

  const indices: number[] = []
  for (const id of span.messageIds) {
    const index = indexById.get(id)
    if (index === undefined) return null
    indices.push(index)
  }

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) {
      return null
    }
  }

  const start = indices[0]!
  const end = indices[indices.length - 1]! + 1
  if (
    messageId(messages[start]!, start) !== span.startMessageId ||
    messageId(messages[end - 1]!, end - 1) !== span.endMessageId
  ) {
    return null
  }

  return {
    start,
    end,
    message: buildCollapsedSummaryMessage(span),
  }
}

export function projectCollapsedView(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ChatMessage[] {
  if (!state.enabled || state.spans.length === 0) {
    return messages
  }

  const projections = state.spans
    .map(span => projectSpan(messages, span))
    .filter((projection): projection is NonNullable<typeof projection> => Boolean(projection))
    .sort((a, b) => a.start - b.start)

  if (projections.length === 0) {
    return messages
  }

  const result: ChatMessage[] = []
  const occupiedIndices = new Set<number>()
  let cursor = 0
  for (const projection of projections) {
    let overlaps = false
    for (let i = projection.start; i < projection.end; i++) {
      if (occupiedIndices.has(i)) {
        overlaps = true
        break
      }
    }
    if (overlaps) {
      continue
    }

    while (cursor < projection.start) {
      result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
      cursor += 1
    }
    result.push(projection.message)
    for (let i = projection.start; i < projection.end; i++) {
      occupiedIndices.add(i)
    }
    cursor = projection.end
  }

  while (cursor < messages.length) {
    result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
    cursor += 1
  }

  return result
}

function buildMessageGroups(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []

  for (let i = 0; i < messages.length;) {
    const message = messages[i]!

    if (message.role === 'assistant_thinking') {
      const groupedMessages: ChatMessage[] = [message]
      let cursor = i + 1
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      const hasToolCall = groupedMessages.some(msg => msg.role === 'assistant_tool_call')
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: hasToolCall && !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'assistant_tool_call') {
      const groupedMessages: ChatMessage[] = []
      let cursor = i
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'tool_result') {
      groups.push({
        start: i,
        end: i + 1,
        messages: [message],
        tokens: estimateMessagesTokens([message]),
        protected: true,
      })
      i += 1
      continue
    }

    groups.push({
      start: i,
      end: i + 1,
      messages: [message],
      tokens: estimateMessagesTokens([message]),
      protected: false,
    })
    i += 1
  }

  return groups
}

function toolGroupIsClosed(messages: ChatMessage[]): boolean {
  const calls = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'assistant_tool_call' }> => (
        message.role === 'assistant_tool_call'
      ))
      .map(message => message.toolUseId),
  )
  const results = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'tool_result' }> => (
        message.role === 'tool_result'
      ))
      .map(message => message.toolUseId),
  )

  if (calls.size === 0 && results.size === 0) return true
  if (calls.size === 0 || results.size === 0) return false
  for (const id of calls) {
    if (!results.has(id)) return false
  }
  for (const id of results) {
    if (!calls.has(id)) return false
  }
  return true
}

function committedCollapsedMessageIds(state: ContextCollapseState): Set<string> {
  const ids = new Set<string>()
  for (const span of state.spans) {
    if (span.status !== 'committed' && span.status !== 'staged') continue
    for (const id of span.messageIds) {
      ids.add(id)
    }
  }
  return ids
}

function desiredTokensToSave(options: ContextCollapseOptions): number {
  if (
    options.currentTokens !== undefined &&
    options.effectiveInput !== undefined &&
    options.effectiveInput > 0
  ) {
    return Math.max(
      options.minTokensToSave,
      Math.ceil(options.currentTokens - options.effectiveInput * options.targetUsage),
    )
  }
  return options.minTokensToSave
}

function buildCandidateFromGroups(
  messages: ChatMessage[],
  groups: MessageGroup[],
  options: ContextCollapseOptions,
): CollapseCandidate | null {
  const desired = desiredTokensToSave(options)
  let tokens = 0
  let endGroupIndex = -1

  for (let i = 0; i < groups.length; i++) {
    tokens += groups[i]!.tokens
    const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
    const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)
    endGroupIndex = i
    if (estimatedTokensToSave >= desired) {
      break
    }
  }

  if (endGroupIndex < 0) return null

  const selectedGroups = groups.slice(0, endGroupIndex + 1)
  const first = selectedGroups[0]!
  const last = selectedGroups[selectedGroups.length - 1]!
  const selectedMessages = messages.slice(first.start, last.end)
  const messageIds = selectedMessages.map((message, offset) => (
    messageId(message, first.start + offset)
  ))
  const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
  const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)

  if (estimatedTokensToSave < options.minTokensToSave) {
    return null
  }

  return {
    startIndex: first.start,
    endIndex: last.end,
    startMessageId: messageIds[0]!,
    endMessageId: messageIds[messageIds.length - 1]!,
    messageIds,
    messages: selectedMessages,
    tokensBefore: tokens,
    estimatedTokensAfter,
    estimatedTokensToSave,
  }
}

export function findCollapseCandidate(
  messages: ChatMessage[],
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {},
): CollapseCandidate | null {
  const options = withDefaultOptions(rawOptions)
  if (messages.length === 0) return null

  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  const keepRecentStart = Math.max(0, messages.length - options.keepRecentMessages)
  const protectedStart = Math.min(
    keepRecentStart,
    lastUserIndex >= 0 ? lastUserIndex : messages.length,
  )
  if (protectedStart <= 0) return null

  const collapsedIds = committedCollapsedMessageIds(state)
  const groups = buildMessageGroups(messages)

  const safeRuns: MessageGroup[][] = []
  let currentRun: MessageGroup[] = []
  const flush = () => {
    if (currentRun.length > 0) {
      safeRuns.push(currentRun)
      currentRun = []
    }
  }

  for (const group of groups) {
    const protectedGroup =
      group.protected ||
      group.start < 0 ||
      group.end > protectedStart ||
      group.messages.some(isCollapseBoundary) ||
      group.messages.some((message, offset) => (
        collapsedIds.has(messageId(message, group.start + offset))
      ))

    if (protectedGroup) {
      flush()
      continue
    }
    currentRun.push(group)
  }
  flush()

  for (const run of safeRuns) {
    const candidate = buildCandidateFromGroups(messages, run, options)
    if (candidate) {
      return candidate
    }
  }

  return null
}

function messageToCollapseText(message: ChatMessage): string {
  switch (message.role) {
    case 'user':
      return `[User]: ${message.content}`
    case 'assistant':
    case 'assistant_progress':
      return `[Assistant]: ${message.content}`
    case 'assistant_thinking':
      return '[Assistant Thinking]: preserved provider reasoning block'
    case 'assistant_tool_call':
      return `[Tool Call: ${message.toolName} ${message.toolUseId}]: ${JSON.stringify(message.input)}`
    case 'tool_result':
      return `[Tool Result: ${message.toolName} ${message.toolUseId}${message.isError ? ' ERROR' : ''}]: ${message.content}`
    case 'context_summary':
      return `[Context Summary]: ${message.content}`
    case 'snip_boundary':
      return `[Snip Boundary]: ${message.content}`
    case 'system':
      return '[System]: protected system message'
  }
}

function messagesToCollapseText(messages: ChatMessage[]): string {
  return messages.map(messageToCollapseText).join('\n\n')
}

export function buildContextCollapseSummaryPrompt(conversationText: string): string {
  return `You are creating a local context-collapse summary for an AI coding session.
The summary will replace only this older message span in the model-visible context.
The original transcript remains preserved outside the model-visible projection.

Produce the final summary in <summary> tags.

Preserve:
- User intent and active goals
- Completed tasks and current state
- Important decisions and constraints
- Tool calls and tool results that still matter
- File reads/writes and code changes, with paths, function names, config names, and commands
- Errors, failures, warnings, and exact messages when relevant
- TODOs, uncertainty, follow-up constraints, and anything still relevant later

Rules:
- Do not invent facts or outcomes
- Do not omit critical paths, function names, configuration keys, file paths, or error text
- Keep it concise, but prefer specificity over vague compression
- This is not a full conversation compact; summarize only the provided span

Messages to summarize:

${conversationText}`
}

function failedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  options: ContextCollapseOptions,
): ContextCollapseResult {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    messages,
    state: {
      ...state,
      spans: [...state.spans],
      consecutiveFailures,
      enabled: consecutiveFailures >= options.maxFailures ? false : state.enabled,
    },
    collapsed: false,
    spans: [],
  }
}

function unchangedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ContextCollapseResult {
  return {
    messages,
    state,
    collapsed: false,
    spans: [],
  }
}

function committedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  plannedSpans: CollapseSpan[],
): ContextCollapseResult {
  const committedSpans = plannedSpans.map(span => ({
    ...span,
    status: 'committed' as const,
  }))
  const nextState: ContextCollapseState = {
    ...state,
    spans: [...state.spans, ...committedSpans],
    consecutiveFailures: 0,
  }

  return {
    messages: projectCollapsedView(messages, nextState),
    state: nextState,
    collapsed: committedSpans.length > 0,
    span: committedSpans[0],
    spans: committedSpans,
  }
}

export async function applyContextCollapseIfNeeded(
  messages: ChatMessage[],
  model: Model,
  adapter: ModelAdapter,
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {},
): Promise<ContextCollapseResult> {
  const options = withDefaultOptions(rawOptions)
  const currentState = normalizeContextCollapseState(state)
  if (!currentState.enabled) {
    return unchangedCollapseResult(messages, currentState)
  }

  const currentProjected = projectCollapsedView(messages, currentState)
  let stats = computeContextStats(currentProjected, model)
  if (stats.utilization < options.utilizationThreshold) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  const plannedSpans: CollapseSpan[] = []
  const maxSpans = Math.max(1, Math.floor(options.maxSpansPerPass))

  for (let pass = 0; pass < maxSpans; pass++) {
    const selectionState: ContextCollapseState = {
      ...currentState,
      spans: [...currentState.spans, ...plannedSpans],
    }
    const projected = projectCollapsedView(messages, selectionState)
    stats = computeContextStats(projected, model)

    if (plannedSpans.length > 0 && stats.utilization <= options.targetUsage) {
      break
    }

    const candidate = findCollapseCandidate(messages, selectionState, {
      ...options,
      currentTokens: stats.totalTokens,
      effectiveInput: stats.effectiveInput,
    })
    if (!candidate) {
      break
    }

    const summaryPrompt = buildContextCollapseSummaryPrompt(
      messagesToCollapseText(candidate.messages),
    )
    const summaryRequestMessages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a precise assistant that summarizes older coding-session context without inventing details.',
      },
      {
        role: 'user',
        content: summaryPrompt,
      },
    ]

    try {
      const response = await adapter.next(summaryRequestMessages)
      if (response.type !== 'assistant' || !response.content.trim()) {
        return failedCollapseResult(currentProjected, currentState, options)
      }

      const summary = parseSummaryFromResponse(response.content)
      if (!summary) {
        return failedCollapseResult(currentProjected, currentState, options)
      }

      const now = Date.now()
      const draftSpan: CollapseSpan = {
        id: `collapse-${now}-${pass}-${candidate.startMessageId}`,
        startMessageId: candidate.startMessageId,
        endMessageId: candidate.endMessageId,
        messageIds: candidate.messageIds,
        summary,
        tokensBefore: candidate.tokensBefore,
        tokensAfter: 0,
        status: 'staged',
        createdAt: now,
        reason: options.reason,
      }
      const summaryTokens = estimateMessagesTokens([buildCollapsedSummaryMessage(draftSpan)])
      const tokensToSave = Math.max(0, candidate.tokensBefore - summaryTokens)
      if (tokensToSave < options.minTokensToSave) {
        if (plannedSpans.length > 0) break
        return failedCollapseResult(currentProjected, currentState, options)
      }

      plannedSpans.push({
        ...draftSpan,
        tokensAfter: summaryTokens,
      })
    } catch {
      return failedCollapseResult(currentProjected, currentState, options)
    }
  }

  if (plannedSpans.length === 0) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  return committedCollapseResult(messages, currentState, plannedSpans)
}
