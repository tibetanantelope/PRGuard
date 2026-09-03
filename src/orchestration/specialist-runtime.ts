import type { CheckpointManager } from '../runtime/checkpoint.js'
import { createRuntimeState } from '../runtime/task-state.js'
import type { AgentPhase } from '../runtime/types.js'
import type { OrchestrationBudgetController } from './budget.js'

export type SpecialistRuntimeEvent = {
  phase: 'resumed' | 'attempt_started' | 'attempt_succeeded' | 'attempt_failed'
  specialistId: string
  attempt?: number
  durationMs?: number
  retrying?: boolean
  checkpointRunId?: string
  error?: string
}

export type SpecialistRuntimeResult<T> = {
  value?: T
  attempts: number
  durationMs: number
  checkpointRunId?: string
  resumed?: boolean
  error?: string
}

export type SpecialistRuntimeTask<T> = {
  specialistId: string
  goal: string
  taskId: string
  messagesRef: string
  inputHash: string
  retries: number
  timeoutMs: number
  signal?: AbortSignal
  checkpointManager?: CheckpointManager
  budget: OrchestrationBudgetController
  recover(outputs: Record<string, unknown> | undefined): T | undefined
  serialize(value: T): Record<string, unknown>
  execute(attempt: number, signal: AbortSignal): Promise<T>
  onEvent?(event: SpecialistRuntimeEvent): void | Promise<void>
}

/** Shared lifecycle for routed specialists: budget, timeout, retry and checkpoint recovery. */
export class SpecialistRuntime {
  async run<T>(task: SpecialistRuntimeTask<T>): Promise<SpecialistRuntimeResult<T>> {
    const startedAt = performance.now()
    const cached = await task.checkpointManager?.latestForMessagesRef(task.messagesRef)
    const recovered = cached?.state.run.status === 'completed' && cached.inputHash === task.inputHash
      ? task.recover(cached.outputs)
      : undefined
    if (recovered !== undefined && cached) {
      await task.onEvent?.({
        phase: 'resumed', specialistId: task.specialistId,
        checkpointRunId: cached.runId, durationMs: Math.round(performance.now() - startedAt),
      })
      return {
        value: recovered, attempts: 0, resumed: true, checkpointRunId: cached.runId,
        durationMs: Math.round(performance.now() - startedAt),
      }
    }

    let lastError: unknown
    for (let attempt = 1; attempt <= task.retries + 1; attempt += 1) {
      const state = createRuntimeState(`${task.goal}:attempt-${attempt}`, `${task.taskId}-${attempt}`)
      const checkpoint = async (phase: AgentPhase, value?: T): Promise<void> => {
        if (!task.checkpointManager) return
        const status = phase === 'completed' ? 'completed' as const : phase === 'failed' ? 'failed' as const : 'running' as const
        await task.checkpointManager.commit({
          state: { ...state, run: { ...state.run, phase, status } },
          messagesRef: task.messagesRef,
          inputHash: task.inputHash,
          outputs: value === undefined ? undefined : task.serialize(value),
          idempotencyKey: `${task.specialistId}:attempt-${attempt}:${phase}`,
        })
      }
      const controller = new AbortController()
      const onAbort = () => controller.abort(task.signal?.reason)
      task.signal?.addEventListener('abort', onAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let releaseAgent: (() => void) | undefined
      try {
        releaseAgent = task.budget.enterAgent()
        await task.onEvent?.({ phase: 'attempt_started', specialistId: task.specialistId, attempt })
        await checkpoint('planning')
        await checkpoint('executing')
        const value = await Promise.race([
          task.execute(attempt, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(new Error(`${task.specialistId} timed out after ${task.timeoutMs} ms.`))
              reject(new Error(`${task.specialistId} timed out after ${task.timeoutMs} ms.`))
            }, task.timeoutMs)
          }),
        ])
        await checkpoint('completed', value)
        await task.onEvent?.({
          phase: 'attempt_succeeded', specialistId: task.specialistId, attempt,
          durationMs: Math.round(performance.now() - startedAt),
        })
        return {
          value, attempts: attempt, checkpointRunId: state.run.runId,
          durationMs: Math.round(performance.now() - startedAt),
        }
      } catch (error) {
        lastError = error
        await checkpoint('failed')
        await task.onEvent?.({
          phase: 'attempt_failed', specialistId: task.specialistId, attempt,
          retrying: attempt <= task.retries && !task.signal?.aborted,
          error: error instanceof Error ? error.message : String(error),
        })
        if (task.signal?.aborted) break
      } finally {
        if (timer) clearTimeout(timer)
        releaseAgent?.()
        task.signal?.removeEventListener('abort', onAbort)
      }
    }
    return {
      attempts: task.retries + 1,
      durationMs: Math.round(performance.now() - startedAt),
      error: lastError instanceof Error ? lastError.message : String(lastError),
    }
  }
}
