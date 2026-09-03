export type ReviewJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

const allowedTransitions: Record<ReviewJobStatus, ReadonlySet<ReviewJobStatus>> = {
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'timed_out', 'cancelled']),
  completed: new Set(),
  failed: new Set(['queued']),
  timed_out: new Set(['queued']),
  cancelled: new Set(['queued']),
}

export function canTransitionReviewJob(from: ReviewJobStatus, to: ReviewJobStatus): boolean {
  return allowedTransitions[from].has(to)
}

export function assertReviewJobTransition(from: ReviewJobStatus, to: ReviewJobStatus): void {
  if (!canTransitionReviewJob(from, to)) {
    throw new Error(`Invalid PRGuard job transition: ${from} -> ${to}`)
  }
}

export function isTerminalReviewJobStatus(status: ReviewJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled'
}
