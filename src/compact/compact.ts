import type { ChatMessage, CompressionResult } from '../types.js'
import type { ModelAdapter } from '../types.js'
import {
  estimateMessagesTokens,
  markProviderUsageStale,
  tokenCountWithEstimation,
} from '../utils/token-estimator.js'
import { RETENTION } from './constants.js'
import { buildCompactSummaryPrompt, parseSummaryFromResponse } from './prompt.js'

function groupMessagesByApiRound(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []

  for (let i = 0; i < messages.length;) {
    const group: ChatMessage[] = []
    let cursor = i

    if (messages[cursor]?.role === 'assistant_thinking') {
      group.push(messages[cursor])
      cursor += 1
    }

    while (messages[cursor]?.role === 'assistant_tool_call') {
      group.push(messages[cursor])
      cursor += 1
    }

    while (messages[cursor]?.role === 'tool_result') {
      group.push(messages[cursor])
      cursor += 1
    }

    if (group.some(msg => msg.role === 'assistant_tool_call' || msg.role === 'tool_result')) {
      groups.push(group)
      i = cursor
      continue
    }

    groups.push([messages[i]])
    i += 1
  }

  return groups
}

function alignBoundaryToApiRound(messages: ChatMessage[], boundary: number): number {
  let start = 0
  for (const group of groupMessagesByApiRound(messages)) {
    const end = start + group.length
    if (boundary > start && boundary < end) {
      return start
    }
    start = end
  }
  return boundary
}

function findRetentionBoundary(messages: ChatMessage[]): number {
  // Strategy: scan from the tail, accumulating tokens until we hit limits.
  // Everything before the boundary gets compressed; from boundary onward is kept.
  let tokenSum = 0
  let boundary = messages.length

  for (let i = messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateMessagesTokens([messages[i]])

    // Stop if adding this message would exceed MAX_KEEP_TOKENS
    if (tokenSum + msgTokens > RETENTION.MAX_KEEP_TOKENS) {
      break
    }

    tokenSum += msgTokens
    boundary = i
  }

  // Ensure we keep at least MIN_KEEP_MESSAGES
  const minBoundary = Math.max(1, messages.length - RETENTION.MIN_KEEP_MESSAGES)
  boundary = Math.min(boundary, minBoundary)

  // If we're still keeping almost everything, just keep MIN_KEEP_MESSAGES
  if (boundary <= 1 && messages.length > RETENTION.MIN_KEEP_MESSAGES + 1) {
    boundary = Math.max(1, messages.length - RETENTION.MIN_KEEP_MESSAGES)
  }

  return alignBoundaryToApiRound(messages, boundary)
}

function messagesToText(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        parts.push(`[User]: ${msg.content}`)
        break
      case 'assistant':
      case 'assistant_progress':
        parts.push(`[Assistant]: ${msg.content}`)
        break
      case 'assistant_thinking':
        parts.push('[Assistant Thinking]: preserved provider reasoning block')
        break
      case 'assistant_tool_call':
        parts.push(`[Tool Call: ${msg.toolName}]: ${JSON.stringify(msg.input)}`)
        break
      case 'tool_result':
        const content = msg.content.length > 500
          ? `${msg.content.slice(0, 500)}... (truncated)`
          : msg.content
        parts.push(`[Tool Result: ${msg.toolName}${msg.isError ? ' ERROR' : ''}]: ${content}`)
        break
      case 'context_summary':
        parts.push(`[Previous Summary]: ${msg.content}`)
        break
      case 'snip_boundary':
        parts.push(`[Snipped Context Boundary]: ${msg.content}`)
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

export async function compactConversation(
  messages: ChatMessage[],
  modelAdapter: ModelAdapter,
): Promise<CompressionResult | null> {
  if (messages.length <= 2) {
    return null
  }

  const tokensBefore = tokenCountWithEstimation(messages).totalTokens

  const systemMessages = messages.filter(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')

  if (nonSystemMessages.length <= RETENTION.MIN_KEEP_MESSAGES) {
    return null
  }

  const boundary = findRetentionBoundary(messages)
  const messagesToCompress = messages.slice(1, boundary)
  const messagesToKeep = messages
    .slice(boundary)
    .map(message => markProviderUsageStale(
      message,
      'conversation was compacted after this provider usage was recorded',
    ))

  if (messagesToCompress.length === 0) {
    return null
  }

  const conversationText = messagesToText(messagesToCompress)
  const summaryPrompt = buildCompactSummaryPrompt(conversationText)

  const summaryRequestMessages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant that summarizes conversations concisely.' },
    { role: 'user', content: summaryPrompt },
  ]

  try {
    const response = await modelAdapter.next(summaryRequestMessages)
    if (response.type !== 'assistant' || !response.content.trim()) {
      return null
    }

    const summaryContent = parseSummaryFromResponse(response.content)
    if (!summaryContent) {
      return null
    }

    const summaryMessage: Extract<ChatMessage, { role: 'context_summary' }> = {
      role: 'context_summary',
      content: summaryContent,
      compressedCount: messagesToCompress.length,
      timestamp: Date.now(),
    }

    const newMessages: ChatMessage[] = [
      ...systemMessages,
      summaryMessage,
      ...messagesToKeep,
    ]

    const tokensAfter = tokenCountWithEstimation(newMessages).totalTokens

    return {
      messages: newMessages,
      summary: summaryMessage,
      removedCount: messagesToCompress.length,
      tokensBefore,
      tokensAfter,
    }
  } catch {
    return null
  }
}

export { groupMessagesByApiRound, findRetentionBoundary, messagesToText }
