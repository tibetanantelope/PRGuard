import { createId } from './ids.js'
import type {
  AgentRun,
  AgentRunStatus,
  AgentPhase,
  FileFact,
  MemoryFact,
  PendingAction,
  RuntimeState,
  TaskStep,
  WorkingMemory,
  TaskStepCapability,
} from './types.js'
import { RUNTIME_SCHEMA_VERSION } from './types.js'

export function createWorkingMemory(goal: string): WorkingMemory {
  if (!goal.trim()) throw new Error('Working memory goal cannot be empty.')
  return {
    goal,
    plan: [],
    completedSteps: [],
    constraints: [],
    discoveredFacts: [],
    modifiedFiles: [],
    recentErrors: [],
    pendingActions: [],
    artifactRefs: [],
  }
}

export function createAgentRun(args: {
  taskId: string
  runId?: string
  phase?: AgentPhase
  now?: string
  budget?: import('./types.js').RuntimeBudget
}): AgentRun {
  const now = args.now ?? new Date().toISOString()
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runId: args.runId ?? createId('run'),
    taskId: args.taskId,
    status: 'running',
    phase: args.phase ?? 'input_loaded',
    attempt: 0,
    budget: args.budget ?? {},
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function createRuntimeState(goal: string, taskId: string, now?: string): RuntimeState {
  return {
    run: createAgentRun({ taskId, now }),
    workingMemory: createWorkingMemory(goal),
  }
}

export function addPlanStep(memory: WorkingMemory, description: string, id?: string, options: {
  capability?: TaskStepCapability
  dependsOn?: string[]
  acceptanceCriteria?: string
  assignedAgent?: string
} = {}): WorkingMemory {
  if (!description.trim()) throw new Error('Task step description cannot be empty.')
  const stepId = id ?? createId('step')
  const step: TaskStep = {
    id: stepId,
    description,
    status: 'pending',
    attempts: 0,
    capability: options.capability ?? 'reasoning',
    dependsOn: [...(options.dependsOn ?? [])],
    acceptanceCriteria: options.acceptanceCriteria ?? `完成：${description}`,
    assignedAgent: options.assignedAgent,
    idempotencyKey: stepId,
  }
  return { ...memory, plan: [...memory.plan, step] }
}

export function readyPlanSteps(memory: WorkingMemory): TaskStep[] {
  const completed = new Set(memory.plan.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id))
  return memory.plan.filter(step => step.status === 'pending' && step.dependsOn.every(id => completed.has(id)))
}

export function activatePlanStep(memory: WorkingMemory, capability?: TaskStepCapability): WorkingMemory {
  const current = memory.plan.find(step => step.status === 'running')
  if (current && (!capability || current.capability === capability || current.capability === 'recovery')) {
    return { ...memory, activeStep: current.id }
  }
  const ready = readyPlanSteps(memory)
  const selected = ready.find(step => !capability || step.capability === capability || step.capability === 'recovery') ?? (capability ? undefined : ready[0])
  if (!selected) return memory
  return updatePlanStep(memory, selected.id, { status: 'running', attempts: selected.attempts + 1 })
}

export function completeActivePlanStep(memory: WorkingMemory, resultRef?: string): WorkingMemory {
  if (!memory.activeStep) return memory
  return updatePlanStep(memory, memory.activeStep, { status: 'completed', resultRef, error: undefined })
}

export function failActivePlanStep(memory: WorkingMemory, error: string): WorkingMemory {
  if (!memory.activeStep) return memory
  return updatePlanStep(memory, memory.activeStep, { status: 'failed', error })
}

export function updatePlanStep(
  memory: WorkingMemory,
  stepId: string,
  update: Partial<Pick<TaskStep, 'status' | 'attempts' | 'error' | 'resultRef'>>,
): WorkingMemory {
  let found = false
  const plan = memory.plan.map(step => {
    if (step.id !== stepId) return step
    found = true
    return { ...step, ...update }
  })
  if (!found) throw new Error(`Unknown task step: ${stepId}`)
  const completedSteps = plan.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id)
  return {
    ...memory,
    plan,
    completedSteps,
    activeStep: plan.find(step => step.status === 'running')?.id,
  }
}

export function addFact(memory: WorkingMemory, fact: Omit<MemoryFact, 'id'> & { id?: string }): WorkingMemory {
  const next = { ...fact, id: fact.id ?? createId('fact') }
  const discoveredFacts = memory.discoveredFacts.filter(existing => existing.key !== next.key)
  return { ...memory, discoveredFacts: [...discoveredFacts, next] }
}

export function addFileFact(memory: WorkingMemory, fact: FileFact): WorkingMemory {
  const modifiedFiles = memory.modifiedFiles.filter(existing => existing.path !== fact.path)
  return { ...memory, modifiedFiles: [...modifiedFiles, fact] }
}

export function addPendingAction(memory: WorkingMemory, action: Omit<PendingAction, 'id'> & { id?: string }): WorkingMemory {
  const next = { ...action, id: action.id ?? createId('action') }
  if (memory.pendingActions.some(existing => existing.idempotencyKey === next.idempotencyKey)) return memory
  return { ...memory, pendingActions: [...memory.pendingActions, next] }
}

export function removePendingAction(memory: WorkingMemory, idempotencyKey: string): WorkingMemory {
  return { ...memory, pendingActions: memory.pendingActions.filter(action => action.idempotencyKey !== idempotencyKey) }
}

export function addConstraint(memory: WorkingMemory, constraint: string): WorkingMemory {
  if (!constraint.trim() || memory.constraints.includes(constraint)) return memory
  return { ...memory, constraints: [...memory.constraints, constraint] }
}

export function replaceRuntimeState(
  state: RuntimeState,
  update: { run?: Partial<AgentRun>; workingMemory?: Partial<WorkingMemory> },
): RuntimeState {
  return {
    run: update.run ? { ...state.run, ...update.run } : state.run,
    workingMemory: update.workingMemory ? { ...state.workingMemory, ...update.workingMemory } : state.workingMemory,
  }
}

export type { AgentRunStatus }
