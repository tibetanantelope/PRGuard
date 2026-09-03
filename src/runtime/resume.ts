import { runAgentTurn } from '../agent-loop.js'
import type { CheckpointManager, WorkingMemoryStore } from './checkpoint.js'
import type { AgentRunStatus } from './types.js'

export type ResumeAgentTurnArgs = Omit<Parameters<typeof runAgentTurn>[0], 'runtimeState' | 'workingMemory' | 'workingMemoryStore' | 'workingMemoryRunId'> & {
  checkpointManager: CheckpointManager
  workingMemoryStore: WorkingMemoryStore
  runId: string
  expectedInputHash?: string
}

const resumableStatuses: AgentRunStatus[] = ['running', 'failed', 'cancelled']

export async function resumeAgentTurn(args: ResumeAgentTurnArgs): Promise<Awaited<ReturnType<typeof runAgentTurn>>> {
  const checkpoint = await args.checkpointManager.latest(args.runId)
  if (!checkpoint) throw new Error(`No checkpoint found for runtime run ${args.runId}.`)
  if (args.expectedInputHash !== undefined && checkpoint.inputHash !== args.expectedInputHash) {
    throw new Error(`Checkpoint input hash mismatch for run ${args.runId}.`)
  }
  const state = checkpoint.state
  if (!resumableStatuses.includes(state.run.status)) {
    throw new Error(`Runtime run ${args.runId} is already completed and cannot be resumed.`)
  }
  const memory = await args.workingMemoryStore.load(args.runId)
  return runAgentTurn({
    ...args,
    messages: checkpoint.messagesSnapshot ?? args.messages,
    runtimeState: state,
    workingMemory: memory?.memory ?? state.workingMemory,
    workingMemoryStore: args.workingMemoryStore,
    workingMemoryRunId: args.runId,
  })
}
