import type { MemoryRetrievalConfig, MemorySearchQuery } from './types.js'
import type { MemoryRetriever } from './retriever.js'

export type MemoryEvalCase = {
  query: MemorySearchQuery
  relevantIds: string[]
}

export type MemoryEvalResult = {
  cases: number
  recallAtK: number
  meanReciprocalRank: number
}

export async function evaluateMemoryRetrieval(
  retriever: MemoryRetriever,
  cases: MemoryEvalCase[],
  config: Partial<MemoryRetrievalConfig> = {},
): Promise<MemoryEvalResult> {
  if (cases.length === 0) return { cases: 0, recallAtK: 0, meanReciprocalRank: 0 }
  let recalled = 0
  let reciprocalRank = 0
  for (const item of cases) {
    const result = await retriever.retrieve(item.query, config)
    const relevant = new Set(item.relevantIds)
    const rank = result.findIndex(memory => relevant.has(memory.id))
    if (rank >= 0) {
      recalled += 1
      reciprocalRank += 1 / (rank + 1)
    }
  }
  return {
    cases: cases.length,
    recallAtK: recalled / cases.length,
    meanReciprocalRank: reciprocalRank / cases.length,
  }
}
