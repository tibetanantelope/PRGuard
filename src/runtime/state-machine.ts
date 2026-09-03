import type { AgentPhase, AgentRun, AgentRunStatus } from './types.js'

const transitions: Record<AgentPhase, readonly AgentPhase[]> = {
  input_loaded: ['planning', 'failed', 'cancelled'],
  planning: ['executing', 'context_managing', 'failed', 'cancelled'],
  executing: ['observing', 'context_managing', 'completed', 'failed', 'cancelled'],
  observing: ['executing', 'context_managing', 'aggregating', 'repairing', 'verifying', 'publishing', 'completed', 'failed', 'cancelled'],
  context_managing: ['planning', 'executing', 'observing', 'failed', 'cancelled'],
  aggregating: ['repairing', 'verifying', 'publishing', 'completed', 'failed', 'cancelled'],
  repairing: ['verifying', 'observing', 'failed', 'cancelled'],
  verifying: ['repairing', 'publishing', 'completed', 'failed', 'cancelled'],
  publishing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['planning'],
  cancelled: ['planning'],
}

const terminalStatuses: Record<AgentPhase, AgentRunStatus | undefined> = {
  input_loaded: undefined,
  planning: undefined,
  executing: undefined,
  observing: undefined,
  context_managing: undefined,
  aggregating: undefined,
  repairing: undefined,
  verifying: undefined,
  publishing: undefined,
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
}

export function canTransition(from: AgentPhase, to: AgentPhase): boolean {
  return transitions[from].includes(to)
}

export function assertValidTransition(from: AgentPhase, to: AgentPhase): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid Agent phase transition: ${from} -> ${to}`)
  }
}

export function transitionRun(
  run: AgentRun,
  nextPhase: AgentPhase,
  now = new Date().toISOString(),
): AgentRun {
  assertValidTransition(run.phase, nextPhase)
  const status = terminalStatuses[nextPhase] ?? 'running'
  return {
    ...run,
    phase: nextPhase,
    status,
    updatedAt: now,
  }
}

export function getAllowedTransitions(phase: AgentPhase): readonly AgentPhase[] {
  return transitions[phase]
}
