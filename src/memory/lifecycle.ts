import type { LongTermMemoryItem } from './types.js'

export type MemoryStatus = NonNullable<LongTermMemoryItem['status']>

const transitions: Record<MemoryStatus, MemoryStatus[]> = {
  active: ['superseded', 'archived'],
  superseded: ['archived'],
  archived: [],
}

export function canTransitionMemoryStatus(from: MemoryStatus, to: MemoryStatus): boolean {
  return from === to || transitions[from].includes(to)
}

export function assertMemoryStatusTransition(from: MemoryStatus, to: MemoryStatus): void {
  if (!canTransitionMemoryStatus(from, to)) {
    throw new Error(`Invalid memory status transition: ${from} -> ${to}.`)
  }
}

export function memoryUtility(item: LongTermMemoryItem): number {
  const authority = item.source === 'human' ? 4 : item.source === 'system' ? 2 : 1
  return authority + item.confidence * 2 + Math.log1p(item.usageCount ?? 0)
    + (item.successCount ?? 0) * 0.25 - (item.failureCount ?? 0) * 0.5
}
