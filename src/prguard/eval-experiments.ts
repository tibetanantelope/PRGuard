import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeConfig } from '../config.js'
import {
  runRuleBaseline,
  type EvalPrediction,
} from './eval.js'
import { formatExperimentSummary, runEvaluationExperiment, type EvalExperimentResult } from './eval-runner.js'
import { loadPrDiffSnapshot } from './repository.js'
import { runMultiAgentPrReview } from './multi-review.js'
import { runPrReview } from './review.js'
import { runAdaptivePrReview } from './adaptive-review.js'
import { createPrGuardTrace, loadPrGuardTrace } from './trace.js'
import type { Finding, ReviewResult } from './types.js'

export const evalExperimentModes = [
  'rule-baseline',
  'single-agent',
  'multi-agent',
  'multi-agent-verifier',
  'adaptive',
] as const

export type EvalExperimentMode = (typeof evalExperimentModes)[number]

export { formatExperimentSummary }

function findingsToPredictions(findings: Finding[]): EvalPrediction['findings'] {
  return findings.map(finding => ({
    category: finding.category,
    severity: finding.severity,
    file: finding.file,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    title: finding.title,
  }))
}

function traceTelemetry(events: Awaited<ReturnType<typeof loadPrGuardTrace>>): Pick<EvalPrediction, 'toolCalls' | 'tokens'> {
  const toolCalls = events.filter(event => event.type === 'tool_finished').length
  const tokens = events
    .filter(event => event.type === 'model_response')
    .reduce((sum, event) => {
      const usage = event.payload.usage
      if (!usage || typeof usage !== 'object') return sum
      const total = (usage as Record<string, unknown>).totalTokens
      return sum + (typeof total === 'number' && Number.isFinite(total) ? total : 0)
    }, 0)
  return { toolCalls, tokens }
}

function reviewToRunResult(result: ReviewResult, telemetry: Pick<EvalPrediction, 'toolCalls' | 'tokens'>) {
  const enriched = result as ReviewResult & {
    agents?: Array<{ failed?: string; fallback?: boolean }>
    aggregation?: { fallbackUsed: boolean }
  }
  return {
    findings: findingsToPredictions(result.findings),
    toolCalls: telemetry.toolCalls,
    tokens: telemetry.tokens,
    patchTestPassed: null,
    adaptiveEscalated: result.routing?.escalated,
    verifierInvoked: result.evidenceVerification !== undefined,
    verifierCheckedFindingCount: result.evidenceVerification?.checkedFindingCount,
    verifierRejectedFindingCount: result.evidenceVerification?.rejectedFindingCount,
    fallbackUsed: enriched.aggregation?.fallbackUsed,
    specialistCount: enriched.agents?.filter(agent => agent.fallback !== true).length,
    specialistFailureCount: enriched.agents?.filter(agent => Boolean(agent.failed)).length,
  }
}

export async function runPrGuardEvaluation(options: {
  datasetPath: string
  outputDir: string
  mode: EvalExperimentMode
  runtime?: RuntimeConfig
  cwd?: string
  model?: string
  promptVersion?: string
  split?: 'validation' | 'holdout'
  runId?: string
}): Promise<EvalExperimentResult> {
  const cwd = options.cwd ?? process.cwd()
  const model = options.model ?? options.runtime?.model ?? 'rule-engine'
  const promptVersion = options.promptVersion ?? 'prguard-review-v1'
  if (options.mode !== 'rule-baseline' && !options.runtime) {
    throw new Error(`Runtime configuration is required for ${options.mode}.`)
  }

  return runEvaluationExperiment({
    datasetPath: options.datasetPath,
    outputDir: options.outputDir,
    mode: options.mode,
    model,
    promptVersion,
    split: options.split,
    runId: options.runId,
    runner: async (task, context) => {
      const fixturePath = path.resolve(path.dirname(options.datasetPath), task.fixture)
      const diffPath = path.relative(cwd, fixturePath)
      if (options.mode === 'rule-baseline') {
        return {
          findings: runRuleBaseline(await readFile(fixturePath, 'utf8')),
          toolCalls: 0,
          tokens: 0,
          patchTestPassed: null,
        }
      }
      const snapshot = await loadPrDiffSnapshot({ cwd, diffPath })
      const trace = await createPrGuardTrace(snapshot.input, {
        runId: `${context.runId}-${task.id}`,
        baseDir: path.join(options.outputDir, 'traces'),
      })
      try {
        const result = options.mode === 'single-agent'
          ? await runPrReview(snapshot, options.runtime!, { trace, evidenceVerification: false })
          : options.mode === 'adaptive'
            ? await runAdaptivePrReview(snapshot, options.runtime!, { trace })
          : await runMultiAgentPrReview(snapshot, options.runtime!, {
              trace,
              evidenceVerification: options.mode === 'multi-agent-verifier',
            })
        await trace.record('run_finished', { status: 'completed', mode: options.mode })
        await trace.flush()
        return {
          ...reviewToRunResult(result, traceTelemetry(await loadPrGuardTrace(trace.runId, path.join(options.outputDir, 'traces')))),
          traceRunId: trace.runId,
        }
      } catch (error) {
        await trace.record('run_failed', { phase: 'evaluation', error: error instanceof Error ? error.message : String(error) })
        await trace.flush()
        throw error
      }
    },
  })
}
