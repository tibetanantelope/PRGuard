import { LongTermMemoryStore } from './store.js'
import type { LongTermMemoryItem } from './types.js'

export type EpisodicMemoryInput = Omit<LongTermMemoryItem, 'id' | 'kind'> & { id?: string }

export class EpisodicMemoryStore extends LongTermMemoryStore {
  constructor(baseDir?: string) {
    super('episodic', baseDir)
  }

  remember(input: EpisodicMemoryInput): Promise<LongTermMemoryItem> {
    return this.save(input)
  }
}
