export const RUNTIME_SCHEMA_VERSION = '0.1'

export const agentPhases = [
  'input_loaded',
  'planning',
  'executing',
  'observing',
  'context_managing',
  'aggregating',
  'repairing',
  'verifying',
  'publishing',
  'completed',
  'failed',
  'cancelled',
] as const

export type AgentPhase = (typeof agentPhases)[number]

export const agentRunStatuses = [
  'running',
  'completed',
  'failed',
  'cancelled',
] as const

export type AgentRunStatus = (typeof agentRunStatuses)[number]

export type TaskStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type TaskStepCapability = 'reasoning' | 'read' | 'write' | 'verify' | 'report' | 'recovery'

export type TaskStep = {
  id: string
  description: string
  status: TaskStepStatus
  attempts: number
  capability: TaskStepCapability
  dependsOn: string[]
  acceptanceCriteria: string
  assignedAgent?: string
  idempotencyKey: string
  resultRef?: string
  error?: string
}

export type MemoryFact = {
  id: string
  key: string
  value: string
  source: string
  confidence: number
  observedAt: string
}

export type FileFact = {
  path: string
  contentHash?: string
  lineStart?: number
  lineEnd?: number
  summary?: string
  source: string
  observedAt: string
}

export type AgentError = {
  phase: AgentPhase
  message: string
  retryable: boolean
  occurredAt: string
}

export type PendingAction = {
  id: string
  kind: 'model_call' | 'tool_call' | 'side_effect'
  description: string
  idempotencyKey: string
  stepId?: string
  callId?: string
  toolName?: string
  toolInput?: unknown
  toolRisk?: 'read_only' | 'state_changing' | 'external_side_effect'
}

export type WorkingMemory = {
  goal: string
  plan: TaskStep[]
  activeStep?: string
  completedSteps: string[]
  constraints: string[]
  discoveredFacts: MemoryFact[]
  modifiedFiles: FileFact[]
  recentErrors: AgentError[]
  pendingActions: PendingAction[]
  artifactRefs: string[]
}

export type AgentRun = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  runId: string
  taskId: string
  status: AgentRunStatus
  phase: AgentPhase
  attempt: number
  budget: RuntimeBudget
  usage: RuntimeUsage
  createdAt: string
  updatedAt: string
}

export type RuntimeBudget = {
  maxModelCalls?: number
  maxToolCalls?: number
  maxDurationMs?: number
  maxInputTokens?: number
  maxOutputTokens?: number
}

export type RuntimeUsage = {
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  startedAt: string
}

export type RuntimeState = {
  run: AgentRun
  workingMemory: WorkingMemory
}
