export type MemoryCandidate = {
  kind: 'semantic' | 'procedural'
  category: string
  content: string
  tags: string[]
  importance: number
}

const procedureSignal = /(first|then|finally|step|run|execute|retry|check|configure|install|command|workflow|先|然后|最后|步骤|执行|运行|重试|检查|配置|安装|命令|流程)/iu
const preferenceSignal = /(i prefer|i like|always use|never use|please remember|我偏好|我喜欢|我习惯|以后都|不要再|必须使用)/iu

export function extractMemoryCandidates(input: {
  userInput: string
  assistantText: string
  facts: string[]
  outcome?: 'completed' | 'failed' | 'cancelled'
}): MemoryCandidate[] {
  if (input.outcome === 'cancelled') return []
  const candidates: MemoryCandidate[] = []
  const combined = `${input.userInput}\n${input.assistantText}`.trim()
  if (preferenceSignal.test(combined)) {
    candidates.push({
      kind: 'semantic',
      category: 'user-preference',
      content: `User preference: ${input.userInput.trim()}`,
      tags: ['preference'],
      importance: 0.85,
    })
  }
  if (input.assistantText.trim() && procedureSignal.test(combined)) {
    candidates.push({
      kind: 'procedural',
      category: input.outcome === 'failed' ? 'recovery-procedure' : 'agent-procedure',
      content: `Task: ${input.userInput.trim()}\nProcedure/outcome: ${input.assistantText.trim().slice(0, 1800)}`,
      tags: ['procedure', input.outcome === 'failed' ? 'failure-recovery' : 'reusable'],
      importance: input.outcome === 'failed' ? 0.9 : 0.75,
    })
  }
  return candidates
}
