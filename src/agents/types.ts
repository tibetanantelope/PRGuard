export const MAX_SUB_AGENTS = 3
export const MAX_SUB_AGENT_STEPS = 20

export type SubAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'closed'

export type SubAgentSnapshot = {
  id: string
  task: string
  status: SubAgentStatus
  startedAt: number
  finishedAt?: number
  result?: string
  error?: string
}

export type WaitForSubAgentsResult = {
  timedOut: boolean
  agents: SubAgentSnapshot[]
}

export type SubAgentAggregate = {
  requested: number
  completed: number
  failed: number
  closed: number
  pending: number
  reports: Array<{ agentId: string; task: string; report: string }>
  errors: Array<{ agentId: string; task: string; error: string }>
}
