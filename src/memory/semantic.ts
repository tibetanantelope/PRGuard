import { LongTermMemoryStore } from './store.js'
import type { LongTermMemoryItem } from './types.js'

export type SemanticMemoryInput = Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }

export class SemanticMemoryStore extends LongTermMemoryStore {
  constructor(baseDir?: string) {
    super('semantic', baseDir)
  }

  remember(input: SemanticMemoryInput): Promise<LongTermMemoryItem> {
    return this.save(input)
  }
}
