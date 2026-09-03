import type { AgentStep, ModelAdapter, ModelRequestOptions, ChatMessage } from '../types.js'

export type OrchestrationBudget = {
  maxModelCalls: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxDurationMs: number
  maxConcurrentAgents: number
}

export type OrchestrationUsage = {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  startedAt: number
  activeAgents: number
  peakConcurrentAgents: number
}

export class OrchestrationBudgetExceededError extends Error {
  constructor(readonly dimension: string, message: string) {
    super(message)
    this.name = 'OrchestrationBudgetExceededError'
  }
}

export class OrchestrationBudgetController {
  private readonly usageValue: OrchestrationUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: Date.now(),
    activeAgents: 0,
    peakConcurrentAgents: 0,
  }

  constructor(readonly budget: OrchestrationBudget) {
    if (budget.maxModelCalls < 1 || budget.maxDurationMs < 1 || budget.maxConcurrentAgents < 1) {
      throw new Error('Orchestration budgets must be positive.')
    }
  }

  enterAgent(): () => void {
    this.assertDuration()
    if (this.usageValue.activeAgents >= this.budget.maxConcurrentAgents) {
      throw new OrchestrationBudgetExceededError('concurrency', `Concurrent agent budget exceeded: ${this.budget.maxConcurrentAgents}.`)
    }
    this.usageValue.activeAgents += 1
    this.usageValue.peakConcurrentAgents = Math.max(this.usageValue.peakConcurrentAgents, this.usageValue.activeAgents)
    let released = false
    return () => {
      if (released) return
      released = true
      this.usageValue.activeAgents = Math.max(0, this.usageValue.activeAgents - 1)
    }
  }

  wrap(model: ModelAdapter): ModelAdapter {
    return {
      next: async (messages: ChatMessage[], options?: ModelRequestOptions): Promise<AgentStep> => {
        this.reserveModelCall()
        const result = await model.next(messages, options)
        this.recordUsage(result)
        return result
      },
    }
  }

  snapshot(): OrchestrationUsage & { elapsedMs: number; remainingModelCalls: number } {
    return {
      ...this.usageValue,
      elapsedMs: Date.now() - this.usageValue.startedAt,
      remainingModelCalls: Math.max(0, this.budget.maxModelCalls - this.usageValue.modelCalls),
    }
  }

  private reserveModelCall(): void {
    this.assertDuration()
    if (this.usageValue.modelCalls >= this.budget.maxModelCalls) {
      throw new OrchestrationBudgetExceededError('model_calls', `Model-call budget exceeded: ${this.budget.maxModelCalls}.`)
    }
    this.usageValue.modelCalls += 1
  }

  private recordUsage(result: AgentStep): void {
    this.usageValue.inputTokens += result.usage?.inputTokens ?? 0
    this.usageValue.outputTokens += result.usage?.outputTokens ?? 0
    if (this.budget.maxInputTokens !== undefined && this.usageValue.inputTokens > this.budget.maxInputTokens) {
      throw new OrchestrationBudgetExceededError('input_tokens', `Input-token budget exceeded: ${this.budget.maxInputTokens}.`)
    }
    if (this.budget.maxOutputTokens !== undefined && this.usageValue.outputTokens > this.budget.maxOutputTokens) {
      throw new OrchestrationBudgetExceededError('output_tokens', `Output-token budget exceeded: ${this.budget.maxOutputTokens}.`)
    }
    this.assertDuration()
  }

  private assertDuration(): void {
    if (Date.now() - this.usageValue.startedAt > this.budget.maxDurationMs) {
      throw new OrchestrationBudgetExceededError('duration', `Orchestration duration budget exceeded: ${this.budget.maxDurationMs} ms.`)
    }
  }
}
