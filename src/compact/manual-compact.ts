import type { ChatMessage, CompressionResult } from '../types.js'
import type { ModelAdapter } from '../types.js'
import { compactConversation } from './compact.js'
import { resetAutoCompactState } from './auto-compact.js'

export async function manualCompact(
  messages: ChatMessage[],
  modelAdapter: ModelAdapter,
): Promise<CompressionResult | null> {
  const result = await compactConversation(messages, modelAdapter)
  if (result) {
    resetAutoCompactState()
  }
  return result
}
