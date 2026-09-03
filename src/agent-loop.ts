import type { ToolRegistry, ToolResult } from './tool.js'
import type {
  ChatMessage,
  CompressionResult,
  ModelAdapter,
  ProviderThinkingBlock,
  ProviderUsage,
} from './types.js'
import type { PermissionManager } from './permissions.js'
import { microcompact } from './compact/microcompact.js'
import { autoCompact } from './compact/auto-compact.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
  type ContextCollapseResult,
  type ContextCollapseState,
} from './compact/context-collapse.js'
import { throwIfAborted } from './abort.js'
import {
  snipCompactConversation,
  type SnipCompactResult,
} from './compact/snipCompact.js'
import { computeContextStats } from './utils/token-estimator.js'
import {
  applyToolResultBudget,
  createContentReplacementState,
  replaceLargeToolResult,
  type ContentReplacementState,
  type PendingToolResult,
} from './utils/tool-result-storage.js'
import type { WorkingMemory } from './runtime/types.js'
import { injectWorkingMemory } from './runtime/working-memory-context.js'
import { transitionRun } from './runtime/state-machine.js'
import type { AgentError, RuntimeBudget, RuntimeState } from './runtime/types.js'
import type { CheckpointManager, WorkingMemoryStore } from './runtime/checkpoint.js'
import {
  activatePlanStep,
  completeActivePlanStep,
  failActivePlanStep,
  addPendingAction,
  removePendingAction,
} from './runtime/task-state.js'
import type { LongTermMemoryItem } from './memory/types.js'
import type { AgentMemoryManager } from './memory/manager.js'
import type { RuntimeTrace } from './runtime/trace.js'
import { HeuristicPlanner, validatePlan, type AgentPlanner } from './runtime/planner.js'
import { ToolExecutionLedger } from './runtime/execution-ledger.js'
import type { TaskStepCapability } from './runtime/types.js'
import { createId } from './runtime/ids.js'

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

function withProviderUsage<T extends ChatMessage>(
  message: T,
  usage: ProviderUsage | undefined,
): T {
  if (!usage) return message
  if (
    message.role === 'assistant' ||
    message.role === 'assistant_progress' ||
    message.role === 'assistant_tool_call'
  ) {
    return { ...message, providerUsage: usage } as T
  }
  return message
}

function shouldTreatAssistantAsProgress(args: {
  kind?: 'final' | 'progress'
  content: string
  sawToolResultThisTurn: boolean
}): boolean {
  if (args.kind === 'progress') {
    return true
  }

  if (args.kind === 'final') {
    return false
  }

  if (!args.sawToolResultThisTurn) {
    return false
  }

  return false
}

function formatDiagnostics(args: {
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): string {
  const parts: string[] = []

  if (args.stopReason) {
    parts.push(`stop_reason=${args.stopReason}`)
  }

  if ((args.blockTypes?.length ?? 0) > 0) {
    parts.push(`blocks=${args.blockTypes!.join(',')}`)
  }

  if ((args.ignoredBlockTypes?.length ?? 0) > 0) {
    parts.push(`ignored=${args.ignoredBlockTypes!.join(',')}`)
  }

  return parts.length > 0 ? ` 诊断信息: ${parts.join('; ')}。` : ''
}

function isRecoverableThinkingStop(args: {
  isEmpty: boolean
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): boolean {
  if (!args.isEmpty) {
    return false
  }

  if (args.stopReason !== 'pause_turn' && args.stopReason !== 'max_tokens') {
    return false
  }

  return (
    (args.blockTypes ?? []).includes('thinking') ||
    (args.ignoredBlockTypes ?? []).includes('thinking')
  )
}

export async function runAgentTurn(args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?: number
  modelName?: string
  onToolStart?: (toolName: string, input: unknown) => void
  onToolResult?: (toolName: string, output: string, isError: boolean) => void
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  onAutoCompact?: (result: CompressionResult) => void | Promise<void>
  onSnipCompact?: (result: SnipCompactResult) => void | Promise<void>
  onContextCollapse?: (result: ContextCollapseResult) => void | Promise<void>
  onContextStats?: (stats: import('./utils/token-estimator.js').ContextStats) => void
  contentReplacementState?: ContentReplacementState
  contextCollapseState?: ContextCollapseState
  workingMemory?: WorkingMemory
  workingMemoryStore?: WorkingMemoryStore
  workingMemoryRunId?: string
  longTermMemory?: LongTermMemoryItem[]
  memoryManager?: AgentMemoryManager
  runtimeTrace?: RuntimeTrace
  planner?: AgentPlanner
  onWorkingMemoryPersist?: (revision: number) => void | Promise<void>
  runtimeState?: RuntimeState
  checkpointManager?: CheckpointManager
  runtimeInputHash?: string
  runtimeMessagesRef?: string
  onRuntimeState?: (state: RuntimeState) => void | Promise<void>
  runtimeBudget?: RuntimeBudget
  executionLedger?: ToolExecutionLedger
  signal?: AbortSignal
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps
  const modelName = args.modelName ?? ''
  let messages = args.messages
  let emptyResponseRetryCount = 0
  let recoverableThinkingRetryCount = 0
  let toolErrorCount = 0
  let sawToolResultThisTurn = false
  let snippedThisTurn = false
  const contentReplacementState =
    args.contentReplacementState ?? createContentReplacementState()
  let contextCollapseState =
    args.contextCollapseState ?? createContextCollapseState()
  let workingMemory = args.workingMemory
  let runtimeState = args.runtimeState
  if (!workingMemory && runtimeState) workingMemory = runtimeState.workingMemory
  if (!workingMemory && args.workingMemoryStore && args.workingMemoryRunId) {
    workingMemory = (await args.workingMemoryStore.load(args.workingMemoryRunId))?.memory
  }
  if (!args.longTermMemory && args.memoryManager) {
    const latestUser = [...args.messages].reverse().find(message => message.role === 'user')
    if (latestUser?.role === 'user' && typeof latestUser.content === 'string') {
      args.longTermMemory = await args.memoryManager.retrieve(latestUser.content)
      await args.runtimeTrace?.record('memory_retrieved', {
        count: args.longTermMemory.length,
        memories: args.longTermMemory.map(item => ({
          id: item.id,
          kind: item.kind,
          source: item.source,
          score: item.retrieval,
          provenance: item.provenance,
        })),
      })
    }
  }
  const persistTurnMemory = async (result: ChatMessage[], outcome: 'completed' | 'failed'): Promise<ChatMessage[]> => {
    if (args.memoryManager) {
      const latestUser = [...args.messages].reverse().find(message => message.role === 'user')
      if (latestUser?.role === 'user' && typeof latestUser.content === 'string') {
        await args.memoryManager.recordTurn({
          userInput: latestUser.content,
          messages: result,
          workingMemory,
          outcome,
        })
      }
    }
    await args.runtimeTrace?.record(outcome === 'completed' ? 'run_finished' : 'run_failed', { outcome })
    await args.runtimeTrace?.flush()
    return result
  }
  let memoryPersistedForCompression = false
  const runtimeBudget = args.runtimeBudget ?? runtimeState?.run.budget
  const runtimeStartedAt = Date.now()
  const planner = args.planner ?? new HeuristicPlanner()
  const executionLedger = args.executionLedger ?? (runtimeState ? new ToolExecutionLedger() : undefined)

  class RuntimeBudgetError extends Error {
    constructor(readonly reason: string) {
      super(`Agent runtime budget exceeded: ${reason}`)
      this.name = 'RuntimeBudgetError'
    }
  }

  const publishRuntimeState = async (next: RuntimeState): Promise<void> => {
    runtimeState = next
    workingMemory = next.workingMemory
    await args.onRuntimeState?.(next)
    if (args.checkpointManager) {
      await args.checkpointManager.commit({
        state: next,
        messagesRef: args.runtimeMessagesRef,
        messagesSnapshot: messages,
        inputHash: args.runtimeInputHash,
        idempotencyKey: `${next.run.runId}:${createId('commit')}`,
      })
    }
  }

  const installPlanIfNeeded = async (): Promise<void> => {
    if (!runtimeState || runtimeState.workingMemory.plan.length > 0) return
    const goal = runtimeState.workingMemory.goal || [...args.messages].reverse().find(message => message.role === 'user')?.content
    if (typeof goal !== 'string' || !goal.trim()) return
    const plan = await planner.plan({ goal, workingMemory: runtimeState.workingMemory })
    validatePlan(plan)
    await publishRuntimeState({
      ...runtimeState,
      workingMemory: { ...runtimeState.workingMemory, plan },
    })
    await args.runtimeTrace?.record('phase_changed', { phase: 'planning', planStepCount: plan.length })
  }

  const activateStep = async (capability?: TaskStepCapability): Promise<string | undefined> => {
    if (!runtimeState) return undefined
    const nextMemory = activatePlanStep(runtimeState.workingMemory, capability)
    if (nextMemory !== runtimeState.workingMemory) {
      await publishRuntimeState({ ...runtimeState, workingMemory: nextMemory })
    }
    return runtimeState.workingMemory.activeStep
  }

  const completeStep = async (resultRef?: string): Promise<void> => {
    if (!runtimeState?.workingMemory.activeStep) return
    await publishRuntimeState({ ...runtimeState, workingMemory: completeActivePlanStep(runtimeState.workingMemory, resultRef) })
  }

  const failStep = async (error: string): Promise<void> => {
    if (!runtimeState?.workingMemory.activeStep) return
    await publishRuntimeState({ ...runtimeState, workingMemory: failActivePlanStep(runtimeState.workingMemory, error) })
  }

  const finalizePlan = async (): Promise<void> => {
    if (!runtimeState) return
    const activeId = runtimeState.workingMemory.activeStep
    const plan = runtimeState.workingMemory.plan.map(step => {
      if (step.id === activeId && step.status === 'running') return { ...step, status: 'completed' as const, resultRef: 'assistant:final', error: undefined }
      if (step.status === 'pending') return { ...step, status: 'skipped' as const, resultRef: 'assistant:completed-without-step' }
      return step
    })
    await publishRuntimeState({
      ...runtimeState,
      workingMemory: {
        ...runtimeState.workingMemory,
        plan,
        activeStep: undefined,
        completedSteps: plan.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id),
      },
    })
  }

  const toolCapability = (toolName: string, input: unknown): TaskStepCapability => {
    const risk = args.tools.riskFor(toolName)
    if (risk === 'read_only') return 'read'
    if (toolName === 'run_command' && /(?:test|check|lint|build|pytest|cargo\s+test|go\s+test)/i.test(JSON.stringify(input))) return 'verify'
    return 'write'
  }

  const advanceRuntimePhase = async (phase: RuntimeState['run']['phase']): Promise<void> => {
    if (!runtimeState || runtimeState.run.phase === phase) return
    await args.runtimeTrace?.record('phase_changed', { phase })
    await publishRuntimeState({
      ...runtimeState,
      run: transitionRun(runtimeState.run, phase),
    })
  }

  const recordRuntimeError = async (message: string, retryable: boolean): Promise<void> => {
    if (!runtimeState) return
    const error: AgentError = {
      phase: runtimeState.run.phase,
      message,
      retryable,
      occurredAt: new Date().toISOString(),
    }
    await publishRuntimeState({
      ...runtimeState,
      workingMemory: {
        ...runtimeState.workingMemory,
        recentErrors: [...runtimeState.workingMemory.recentErrors, error].slice(-10),
      },
    })
  }

  const updateRuntimeUsage = async (update: Partial<RuntimeState['run']['usage']>): Promise<void> => {
    if (!runtimeState) return
    await publishRuntimeState({
      ...runtimeState,
      run: {
        ...runtimeState.run,
        usage: { ...runtimeState.run.usage, ...update },
      },
    })
  }

  const checkRuntimeBudget = (kind: 'model' | 'tool' | 'usage'): void => {
    if (!runtimeState || !runtimeBudget) return
    const usage = runtimeState.run.usage
    const nextModelCalls = usage.modelCalls + (kind === 'model' ? 1 : 0)
    const nextToolCalls = usage.toolCalls + (kind === 'tool' ? 1 : 0)
    if (runtimeBudget.maxModelCalls !== undefined && nextModelCalls > runtimeBudget.maxModelCalls) {
      throw new RuntimeBudgetError(`maxModelCalls=${runtimeBudget.maxModelCalls}`)
    }
    if (runtimeBudget.maxToolCalls !== undefined && nextToolCalls > runtimeBudget.maxToolCalls) {
      throw new RuntimeBudgetError(`maxToolCalls=${runtimeBudget.maxToolCalls}`)
    }
    if (runtimeBudget.maxDurationMs !== undefined && Date.now() - runtimeStartedAt > runtimeBudget.maxDurationMs) {
      throw new RuntimeBudgetError(`maxDurationMs=${runtimeBudget.maxDurationMs}`)
    }
    if (runtimeBudget.maxInputTokens !== undefined && usage.inputTokens > runtimeBudget.maxInputTokens) {
      throw new RuntimeBudgetError(`maxInputTokens=${runtimeBudget.maxInputTokens}`)
    }
    if (runtimeBudget.maxOutputTokens !== undefined && usage.outputTokens > runtimeBudget.maxOutputTokens) {
      throw new RuntimeBudgetError(`maxOutputTokens=${runtimeBudget.maxOutputTokens}`)
    }
  }

  const handleRuntimeBudgetError = async (error: RuntimeBudgetError): Promise<void> => {
    await failStep(error.message)
    await recordRuntimeError(error.message, false)
    await advanceRuntimePhase('failed')
  }

  const enforceRuntimeBudget = async (kind: 'model' | 'tool' | 'usage'): Promise<void> => {
    try {
      checkRuntimeBudget(kind)
    } catch (error) {
      if (error instanceof RuntimeBudgetError) await handleRuntimeBudgetError(error)
      throw error
    }
  }

  if (runtimeState) {
    if (runtimeState.run.phase === 'input_loaded' || runtimeState.run.phase === 'failed' || runtimeState.run.phase === 'cancelled') {
      await advanceRuntimePhase('planning')
    }
    await installPlanIfNeeded()
    if (!runtimeState.workingMemory.completedSteps.length) {
      await activateStep('reasoning')
      await completeStep('runtime:goal-understood')
    }
    await activateStep()
  }

  const pendingToolActions = runtimeState?.workingMemory.pendingActions.filter(action => action.kind === 'tool_call') ?? []
  if (runtimeState && pendingToolActions.length > 0) {
    for (const action of pendingToolActions) {
      if (action.callId && messages.some(message => message.role === 'tool_result' && message.toolUseId === action.callId)) {
        await publishRuntimeState({ ...runtimeState, workingMemory: removePendingAction(runtimeState.workingMemory, action.idempotencyKey) })
        continue
      }
      if (!action.callId || !action.toolName || action.toolInput === undefined || !action.toolRisk || !executionLedger) {
        const error = `Cannot safely recover incomplete tool action ${action.idempotencyKey}: checkpoint lacks execution metadata.`
        await recordRuntimeError(error, false)
        await publishRuntimeState({ ...runtimeState, workingMemory: removePendingAction(runtimeState.workingMemory, action.idempotencyKey) })
        continue
      }
      let record = await executionLedger.latest(runtimeState.run.runId, action.idempotencyKey)
      let recoveredResult: ToolResult
      if (record?.status === 'completed' && record.result) {
        recoveredResult = record.result
      } else if (action.toolRisk !== 'read_only') {
        const error = `Indeterminate ${action.toolRisk} action was not replayed during recovery: ${action.toolName} (${action.idempotencyKey})`
        recoveredResult = { ok: false, output: error }
        if (record) await executionLedger.fail(record, error, true)
      } else {
        record ??= await executionLedger.start({
          runId: runtimeState.run.runId,
          idempotencyKey: action.idempotencyKey,
          callId: action.callId,
          toolName: action.toolName,
          risk: action.toolRisk,
          input: action.toolInput,
        })
        recoveredResult = await args.tools.execute(action.toolName, action.toolInput, {
          cwd: args.cwd,
          permissions: args.permissions,
          signal: args.signal,
        })
        if (recoveredResult.ok) await executionLedger.complete(record, recoveredResult)
        else await executionLedger.fail(record, recoveredResult.output)
      }
      const recoveredMessage = await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: action.callId,
        toolName: action.toolName,
        content: recoveredResult.output,
        isError: !recoveredResult.ok,
      }, contentReplacementState)
      messages = [...messages, recoveredMessage]
      if (!recoveredResult.ok) {
        await failStep(recoveredResult.output)
        await recordRuntimeError(`${action.toolName}: ${recoveredResult.output}`, action.toolRisk === 'read_only')
        const plan = await planner.replan({
          goal: runtimeState.workingMemory.goal,
          workingMemory: runtimeState.workingMemory,
          error: recoveredResult.output,
        })
        validatePlan(plan)
        await publishRuntimeState({
          ...runtimeState,
          workingMemory: { ...runtimeState.workingMemory, plan },
        })
        await activateStep('recovery')
      } else if (action.stepId && runtimeState.workingMemory.activeStep === action.stepId) {
        await completeStep(`recovered-tool-execution:${action.idempotencyKey}`)
        await activateStep()
      }
      await publishRuntimeState({ ...runtimeState, workingMemory: removePendingAction(runtimeState.workingMemory, action.idempotencyKey) })
      await args.runtimeTrace?.record('tool_finished', {
        toolName: action.toolName,
        callId: action.callId,
        ok: recoveredResult.ok,
        recovered: true,
        replayed: action.toolRisk === 'read_only' && record?.status !== 'completed',
      })
    }
    if (runtimeState.run.phase === 'executing') await advanceRuntimePhase('observing')
  }

  const persistWorkingMemoryAroundCompression = async (): Promise<void> => {
    if (!workingMemory || !args.workingMemoryStore || !args.workingMemoryRunId) return
    const before = await args.workingMemoryStore.save(args.workingMemoryRunId, workingMemory)
    const after = await args.workingMemoryStore.save(args.workingMemoryRunId, workingMemory)
    memoryPersistedForCompression = true
    await args.onWorkingMemoryPersist?.(after.revision)
    if (after.revision <= before.revision) {
      throw new Error('Working memory persistence revision did not advance.')
    }
  }

  const replaceContextCollapseState = (nextState: ContextCollapseState) => {
    contextCollapseState = nextState
    if (args.contextCollapseState) {
      args.contextCollapseState.spans = [...nextState.spans]
      args.contextCollapseState.enabled = nextState.enabled
      args.contextCollapseState.consecutiveFailures = nextState.consecutiveFailures
    }
  }

  const pushContinuationPrompt = (content: string) => {
    messages = [
      ...messages,
      {
        role: 'user',
        content,
      },
    ]
  }

  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined) => {
    if (!blocks || blocks.length === 0) return
    messages = [
      ...messages,
      {
        role: 'assistant_thinking',
        blocks,
      },
    ]
  }

  for (let step = 0; maxSteps == null || step < maxSteps; step++) {
    throwIfAborted(args.signal)
    await advanceRuntimePhase('executing')
    let latestStats: import('./utils/token-estimator.js').ContextStats | null = null
    let modelMessages = messages

    if (modelName) {
      latestStats = computeContextStats(injectWorkingMemory(messages, workingMemory, args.longTermMemory), modelName)

      if (!snippedThisTurn) {
        await advanceRuntimePhase('context_managing')
        const snipResult = await snipCompactConversation({
          messages,
          contextStats: latestStats,
          modelContextWindow: latestStats.effectiveInput,
        })
        if (snipResult.didSnip) {
          await persistWorkingMemoryAroundCompression()
          messages = snipResult.messages
          snippedThisTurn = true
          await args.onSnipCompact?.(snipResult)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }

      const beforeMicrocompact = messages
      messages = microcompact(messages, modelName)
      if (messages !== beforeMicrocompact) {
        await persistWorkingMemoryAroundCompression()
        latestStats = computeContextStats(messages, modelName)
        args.onContextStats?.(latestStats)
      }

      const collapseResult = await applyContextCollapseIfNeeded(
        messages,
        modelName,
        args.model,
        contextCollapseState,
      )
      replaceContextCollapseState(collapseResult.state)
      modelMessages = collapseResult.messages
      if (collapseResult.collapsed) {
        await args.onContextCollapse?.(collapseResult)
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      } else if (modelMessages !== messages) {
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      }
      await advanceRuntimePhase('executing')
    }

    // AutoCompact: LLM-based compression when context is critical (first step only)
      if (step === 0 && modelName) {
      latestStats = latestStats ?? computeContextStats(injectWorkingMemory(modelMessages, workingMemory), modelName)
      args.onContextStats?.(latestStats)
      if (latestStats.warningLevel === 'critical' || latestStats.warningLevel === 'blocked') {
        const result = await autoCompact(modelMessages, modelName, args.model)
        if (result) {
          await persistWorkingMemoryAroundCompression()
          messages = result.messages
          modelMessages = messages
          replaceContextCollapseState(createContextCollapseState())
          await args.onAutoCompact?.(result)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }
    }

    if (workingMemory && !memoryPersistedForCompression && args.workingMemoryStore && args.workingMemoryRunId) {
      await args.workingMemoryStore.save(args.workingMemoryRunId, workingMemory)
    }
    let next
    try {
      await enforceRuntimeBudget('model')
      await args.runtimeTrace?.record('model_started', { messageCount: modelMessages.length })
      await updateRuntimeUsage({ modelCalls: (runtimeState?.run.usage.modelCalls ?? 0) + 1 })
      next = await args.model.next(injectWorkingMemory(modelMessages, workingMemory, args.longTermMemory), {
        tools: args.tools.list(),
        signal: args.signal,
      })
      await args.runtimeTrace?.record('model_finished', { type: next.type, toolCalls: next.type === 'tool_calls' ? next.calls.length : 0, usage: next.usage })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!(error instanceof RuntimeBudgetError)) {
        await failStep(message)
        await recordRuntimeError(message, !args.signal?.aborted)
      }
      if (!(error instanceof RuntimeBudgetError)) {
        await advanceRuntimePhase(args.signal?.aborted ? 'cancelled' : 'failed')
      }
      throw error
    }

    await updateRuntimeUsage({
      inputTokens: (runtimeState?.run.usage.inputTokens ?? 0) + (next.usage?.inputTokens ?? 0),
      outputTokens: (runtimeState?.run.usage.outputTokens ?? 0) + (next.usage?.outputTokens ?? 0),
    })
    await enforceRuntimeBudget('usage')

    if (next.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(next.content)
      if (
        !isEmpty &&
        shouldTreatAssistantAsProgress({
          kind: next.kind,
          content: next.content,
          sawToolResultThisTurn,
        })
      ) {
        args.onProgressMessage?.(next.content)
        appendThinkingBlocks(next.thinkingBlocks)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: next.content },
        ]
        pushContinuationPrompt(
          sawToolResultThisTurn && next.kind !== 'progress'
            ? 'Continue from your progress update. You have already used tools in this turn, so treat plain status text as progress, not a final answer. Respond with the next concrete tool call, code change, or an explicit <final> answer only if the task is truly complete.'
            : 'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue
      }

      if (
        isRecoverableThinkingStop({
          isEmpty,
          stopReason: next.diagnostics?.stopReason,
          blockTypes: next.diagnostics?.blockTypes,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        }) &&
        recoverableThinkingRetryCount < 3
      ) {
        recoverableThinkingRetryCount += 1
        const stopReason = next.diagnostics?.stopReason
        const progressContent =
          stopReason === 'max_tokens'
            ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
            : '模型返回 pause_turn，正在继续请求后续步骤...'
        args.onProgressMessage?.(progressContent)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: progressContent },
        ]
        pushContinuationPrompt(
          stopReason === 'max_tokens'
            ? 'Your previous response hit max_tokens during thinking before producing the next actionable step. Resume immediately and continue with the next concrete tool call, code change, or an explicit <final> answer only if the task is complete. Do not repeat the earlier plan.'
            : 'Resume from the previous pause_turn and continue the task immediately. Produce the next concrete tool call, code change, or an explicit <final> answer only if the task is complete.',
        )
        continue
      }

      if (isEmpty && emptyResponseRetryCount < 2) {
        emptyResponseRetryCount += 1
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? 'Your last response was empty after recent tool results. Continue immediately by trying the next concrete step, adapting to any tool errors, or giving an explicit <final> answer only if the task is complete.'
            : 'Your last response was empty. Continue immediately with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
        continue
      }

      if (isEmpty) {
        const diagnosticsSuffix = formatDiagnostics({
          stopReason: next.diagnostics?.stopReason,
          blockTypes: next.diagnostics?.blockTypes,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        })
        const fallbackContent =
          sawToolResultThisTurn
            ? toolErrorCount > 0
              ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${toolErrorCount} 个工具报错；请重试、调整命令，或让模型改用其他方案。${diagnosticsSuffix}`
              : `工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。${diagnosticsSuffix}`
            : `模型返回空响应，已停止当前回合。请重试，或要求模型继续。${diagnosticsSuffix}`

        args.onAssistantMessage?.(fallbackContent, { final: true })
        appendThinkingBlocks(next.thinkingBlocks)
        await failStep(fallbackContent)
        await recordRuntimeError(fallbackContent, true)
        await advanceRuntimePhase('failed')
        return await persistTurnMemory([
          ...messages,
          {
            role: 'assistant',
            content: fallbackContent,
          },
        ], 'failed')
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: next.content,
      }
      appendThinkingBlocks(next.thinkingBlocks)
      const withAssistant: ChatMessage[] = [
        ...messages,
        withProviderUsage(assistantMessage, next.usage),
      ]

      if (!isEmpty) {
        args.onAssistantMessage?.(next.content, { final: true })
      }

      messages = withAssistant
      await finalizePlan()
      await advanceRuntimePhase('completed')
      return await persistTurnMemory(withAssistant, 'completed')
    }

    appendThinkingBlocks(next.thinkingBlocks)

    if (next.content) {
      if (next.contentKind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [
          ...messages,
          withProviderUsage({ role: 'assistant_progress', content: next.content }, next.usage),
        ]
        pushContinuationPrompt(
          'Continue immediately from your <progress> update with concrete tool calls, code changes, or an explicit <final> answer only if the task is complete.',
        )
      } else {
        args.onAssistantMessage?.(
          next.content,
          (next.calls?.length ?? 0) > 0 ? undefined : { final: true },
        )
        messages = [
          ...messages,
          withProviderUsage(
            { role: 'assistant', content: next.content },
            (next.calls?.length ?? 0) > 0 ? undefined : next.usage,
          ),
        ]
      }
    }

    if ((next.calls?.length ?? 0) === 0 && next.content && next.contentKind !== 'progress') {
      await finalizePlan()
      await advanceRuntimePhase('completed')
      return await persistTurnMemory(messages, 'completed')
    }

    const executedToolResults: Array<{
      call: (typeof next.calls)[number]
      result: Awaited<ReturnType<ToolRegistry['execute']>>
      toolResult: PendingToolResult
    }> = []

    const toolCallMessages = next.calls.map((call, index) => withProviderUsage<ChatMessage>({
      role: 'assistant_tool_call',
      toolUseId: call.id,
      toolName: call.toolName,
      input: call.input,
    }, index === next.calls.length - 1 ? next.usage : undefined))
    messages = [...messages, ...toolCallMessages]

    for (const call of next.calls) {
      throwIfAborted(args.signal)
      await enforceRuntimeBudget('tool')
      const capability = toolCapability(call.toolName, call.input)
      const active = runtimeState?.workingMemory.plan.find(step => step.id === runtimeState?.workingMemory.activeStep)
      const capabilityOrder: TaskStepCapability[] = ['reasoning', 'read', 'write', 'verify', 'report']
      if (active && active.capability !== capability && active.capability !== 'recovery'
        && capabilityOrder.indexOf(capability) > capabilityOrder.indexOf(active.capability)) {
        await completeStep(`transition:${call.toolName}`)
      }
      await activateStep(capability)
      const selectedStep = runtimeState?.workingMemory.plan.find(step =>
        step.id === runtimeState?.workingMemory.activeStep && (step.capability === capability || step.capability === 'recovery'),
      )
      const actionKey = `${runtimeState?.run.runId ?? 'untracked'}:tool:${call.id}`
      const risk = args.tools.riskFor(call.toolName)
      if (runtimeState) {
        await publishRuntimeState({
          ...runtimeState,
          workingMemory: addPendingAction(runtimeState.workingMemory, {
            kind: 'tool_call',
            description: `${call.toolName} execution`,
            idempotencyKey: actionKey,
            stepId: selectedStep?.id,
            callId: call.id,
            toolName: call.toolName,
            toolInput: call.input,
            toolRisk: risk,
          }),
        })
      }
      await updateRuntimeUsage({ toolCalls: (runtimeState?.run.usage.toolCalls ?? 0) + 1 })
      await advanceRuntimePhase('executing')
      args.onToolStart?.(call.toolName, call.input)
      await args.runtimeTrace?.record('tool_started', { toolName: call.toolName, callId: call.id })
      const previousExecution = runtimeState && executionLedger
        ? await executionLedger.latest(runtimeState.run.runId, actionKey)
        : null
      let result: Awaited<ReturnType<ToolRegistry['execute']>>
      if (previousExecution?.status === 'completed' && previousExecution.result) {
        result = previousExecution.result
      } else if (previousExecution && (previousExecution.status === 'started' || previousExecution.status === 'indeterminate') && risk !== 'read_only') {
        const output = `Tool side effect has an indeterminate prior outcome and was not replayed: ${call.toolName} (${actionKey})`
        result = { ok: false, output }
        if (previousExecution.status !== 'indeterminate') await executionLedger?.fail(previousExecution, output, true)
      } else {
        const started = runtimeState && executionLedger
          ? await executionLedger.start({ runId: runtimeState.run.runId, idempotencyKey: actionKey, callId: call.id, toolName: call.toolName, risk, input: call.input })
          : undefined
        result = await args.tools.execute(
          call.toolName,
          call.input,
          { cwd: args.cwd, permissions: args.permissions, signal: args.signal },
        )
        if (started && executionLedger) {
          if (result.ok) await executionLedger.complete(started, result)
          else await executionLedger.fail(started, result.output)
        }
      }
      sawToolResultThisTurn = true
      if (!result.ok) {
        toolErrorCount += 1
        if (selectedStep) await failStep(result.output)
        await recordRuntimeError(`${call.toolName}: ${result.output}`, true)
        if (runtimeState) {
          const goal = runtimeState.workingMemory.goal
          const plan = await planner.replan({ goal, workingMemory: runtimeState.workingMemory, error: result.output })
          validatePlan(plan)
          await publishRuntimeState({
            ...runtimeState,
            workingMemory: { ...runtimeState.workingMemory, plan },
          })
          await activateStep('recovery')
          await args.runtimeTrace?.record('phase_changed', { phase: 'planning', reason: 'tool_failure', planStepCount: plan.length })
        }
      } else if (selectedStep) {
        await completeStep(`tool-execution:${actionKey}`)
        await activateStep()
      }
      args.onToolResult?.(call.toolName, result.output, !result.ok)
      await args.runtimeTrace?.record('tool_finished', { toolName: call.toolName, callId: call.id, ok: result.ok, outputChars: result.output.length })

      const toolResult = await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: result.output,
        isError: !result.ok,
      }, contentReplacementState)

      executedToolResults.push({
        call,
        result,
        toolResult,
      })
    }

    const budgetedResults = await applyToolResultBudget(
      executedToolResults.map(entry => entry.toolResult),
      contentReplacementState,
    )
    const toolResultById = new Map(
      budgetedResults.results.map(result => [result.toolUseId, result]),
    )

    const toolResults = executedToolResults.map(entry =>
      toolResultById.get(entry.call.id) ?? entry.toolResult,
    )

    messages = [
      ...messages,
      ...toolResults,
    ]
    if (runtimeState) {
      for (const entry of executedToolResults) {
        await publishRuntimeState({
          ...runtimeState,
          workingMemory: removePendingAction(runtimeState.workingMemory, `${runtimeState.run.runId}:tool:${entry.call.id}`),
        })
      }
    }
    await advanceRuntimePhase('observing')

    const awaitUserEntry = executedToolResults.find(entry => entry.result.awaitUser)
    if (awaitUserEntry) {
      const question = awaitUserEntry.result.output.trim()
        if (question.length > 0) {
          args.onAssistantMessage?.(question)
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: question,
            },
          ]
        }
        await advanceRuntimePhase('completed')
        return await persistTurnMemory(messages, 'completed')
    }
  }

  const maxStepContent = `达到最大工具步数限制，已停止当前回合。`
  args.onAssistantMessage?.(maxStepContent, { final: true })
  await failStep(maxStepContent)
  await recordRuntimeError(maxStepContent, false)
  await advanceRuntimePhase('failed')
  return await persistTurnMemory([
    ...messages,
    {
      role: 'assistant',
      content: maxStepContent,
    },
  ], 'failed')
}
