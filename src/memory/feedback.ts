import { LongTermMemoryStore } from './store.js'
import type { FindingFeedback } from './types.js'

export class FindingFeedbackStore extends LongTermMemoryStore {
  constructor(baseDir?: string) {
    super('feedback', baseDir)
  }

  remember(input: Omit<FindingFeedback, 'id' | 'kind'> & { id?: string }): Promise<FindingFeedback> {
    return this.save(input) as Promise<FindingFeedback>
  }

  async latestForFinding(projectId: string, findingId: string, now = new Date()): Promise<FindingFeedback | undefined> {
    const records = await this.list(projectId, now.toISOString())
    return records.find(record => record.metadata?.findingId === findingId) as FindingFeedback | undefined
  }
}
