import { createPrGuardTrace, loadPrGuardTrace, type PrGuardTrace } from './trace.js'
import { loadGithubPrDiffSnapshot } from './github.js'
import { loadPrDiffSnapshot } from './repository.js'
import { runMultiAgentPrReview } from './multi-review.js'
import { runPrReview } from './review.js'
import { reviewInputSchema, type ReviewInput, type ReviewResult } from './types.js'
import type { RuntimeConfig } from '../config.js'

function resumableInput(events: Awaited<ReturnType<typeof loadPrGuardTrace>>): ReviewInput {
  const started = events.find(event => event.type === 'run_started')
  const rawInput = started?.payload.input
  const parsed = reviewInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new Error('This Trace does not contain a resumable review input. Inline Diff-only runs cannot be resumed.')
  }
  return parsed.data
}

export async function resumePrGuardReview(args: {
  runId: string
  runtime: RuntimeConfig
  multiAgent?: boolean
  traceLoader?: typeof loadPrGuardTrace
  traceFactory?: typeof createPrGuardTrace
}): Promise<{ trace: PrGuardTrace; result: ReviewResult }> {
  const loader = args.traceLoader ?? loadPrGuardTrace
  const events = await loader(args.runId)
  const input = resumableInput(events)
  const snapshot = input.githubRef
    ? await loadGithubPrDiffSnapshot({
        cwd: input.cwd,
        githubRef: input.githubRef,
        testCommand: input.testCommand,
      })
    : await loadPrDiffSnapshot(input)
  const factory = args.traceFactory ?? createPrGuardTrace
  const trace = await factory(snapshot.input, { parentRunId: args.runId })
  await trace.record('checkpoint', { phase: 'resume_started', resumedFrom: args.runId })
  const result = args.multiAgent
    ? await runMultiAgentPrReview(snapshot, args.runtime, { trace })
    : await runPrReview(snapshot, args.runtime, { trace })
  await trace.record('run_finished', { status: 'review_completed', resumedFrom: args.runId })
  await trace.flush()
  return { trace, result }
}

