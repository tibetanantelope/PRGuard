import type { LongTermMemoryItem } from './types.js'

const HALF_LIFE_DAYS: Record<LongTermMemoryItem['kind'], number> = {
  episodic: 30,
  semantic: 180,
  procedural: 365,
  feedback: 90,
}

export function memoryDecayWeight(item: LongTermMemoryItem, now = new Date()): number {
  const createdAt = Date.parse(item.createdAt)
  const nowMs = now.getTime()
  if (!Number.isFinite(createdAt) || !Number.isFinite(nowMs) || createdAt > nowMs) return 1
  const ageDays = (nowMs - createdAt) / 86_400_000
  const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS[item.kind])
  return item.source === 'human' ? Math.max(weight, 0.5) : weight
}
