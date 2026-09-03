export type MemoryWriteDecision = {
  shouldRemember: boolean
  importance: number
  reason: string
}

const casual = /^(hi|hello|hey|thanks|thank you|ok|okay|好的|好吧|谢谢|你好|收到)[.!！。 ]*$/iu
const reusableSignal = /(fix|debug|implement|configure|install|review|error|failure|retry|decision|prefer|always|never|修复|调试|实现|配置|安装|审查|错误|失败|重试|决定|偏好|必须|不要)/iu

export function evaluateMemoryWrite(input: {
  userInput: string
  assistantText?: string
  factCount?: number
  outcome?: 'completed' | 'failed' | 'cancelled'
}): MemoryWriteDecision {
  const userInput = input.userInput.trim()
  const assistantText = input.assistantText?.trim() ?? ''
  const factCount = input.factCount ?? 0
  if (!userInput && !assistantText && factCount === 0) return { shouldRemember: false, importance: 0, reason: 'empty-turn' }
  if (input.outcome === 'cancelled') return { shouldRemember: false, importance: 0, reason: 'cancelled-turn' }
  if (casual.test(userInput) && !assistantText && factCount === 0) return { shouldRemember: false, importance: 0.05, reason: 'casual-chitchat' }
  let importance = 0.25
  if (userInput.length >= 40) importance += 0.2
  if (assistantText.length >= 80) importance += 0.2
  if (factCount > 0) importance += 0.25
  if (reusableSignal.test(`${userInput}\n${assistantText}`)) importance += 0.15
  if (input.outcome === 'failed') importance += 0.1
  return {
    shouldRemember: importance >= 0.4,
    importance: Math.min(1, importance),
    reason: importance >= 0.4 ? 'reusable-task-outcome' : 'low-salience-turn',
  }
}
