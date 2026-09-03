import type { RuntimeConfig } from '../config.js'
import {
  applyAndVerifyPatch,
  generatePatch,
  repairWithVerificationRetries,
  type PatchApplicationResult,
} from './repair.js'
import {
  createPrGuardTrace,
  listPrGuardTraces,
  loadPrGuardTrace,
  replayPrGuardTrace,
  type PrGuardTrace,
  type PrGuardTraceEvent,
  type PrGuardTraceSummary,
} from './trace.js'
import { compareEvalReports, evaluateDataset, evaluateGate, formatEvalReport, loadEvalPredictions, type EvalComparison, type EvalGateOptions, type EvalGateResult, type EvalPrediction, type EvalReport } from './eval.js'
import { runMultiAgentPrReview } from './multi-review.js'
import { resumePrGuardReview } from './recovery.js'
import { runPrReview } from './review.js'
import type { Patch, PrDiffSnapshot, ReviewResult } from './types.js'
import { createDefaultReviewPersistence, type ReviewPersistence } from './review-persistence.js'
import { PrGuardMemoryService } from './memory.js'
import type { FindingDecision } from './memory.js'
import type { ModelAdapter } from '../types.js'
import { redactReviewResult, redactSensitiveText } from './redaction.js'
import { CheckpointManager } from '../runtime/checkpoint.js'

export class ReviewService {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly persistence: ReviewPersistence = createDefaultReviewPersistence(runtime.prGuardMySqlUrl),
    private readonly memoryBaseDir?: string,
    private readonly checkpointManager: CheckpointManager = new CheckpointManager(),
  ) {}

  async review(
    snapshot: PrDiffSnapshot,
    options: { multiAgent?: boolean; trace?: PrGuardTrace; jobId?: string; signal?: AbortSignal; model?: ModelAdapter } = {},
  ): Promise<ReviewResult> {
    const memory = new PrGuardMemoryService(snapshot.input.cwd, this.memoryBaseDir)
    try {
      const longTermMemory = await memory.retrieveForReview(snapshot)
      await options.trace?.record('memory_retrieved', {
        count: longTermMemory.length,
        memories: longTermMemory.map(item => ({
          id: item.id,
          kind: item.kind,
          source: item.source,
          score: item.retrieval,
          provenance: item.provenance,
        })),
      })
      const reviewed = await (options.multiAgent
        ? runMultiAgentPrReview(snapshot, this.runtime, {
            model: options.model,
            trace: options.trace,
            signal: options.signal,
            longTermMemory,
            checkpointManager: this.checkpointManager,
            maxSpecialists: this.runtime.prGuardMaxSpecialists,
            criticJudge: this.runtime.prGuardCriticJudgeEnabled,
            orchestrationBudget: {
              maxModelCalls: this.runtime.prGuardOrchestrationMaxModelCalls,
              maxInputTokens: this.runtime.prGuardOrchestrationMaxInputTokens,
              maxOutputTokens: this.runtime.prGuardOrchestrationMaxOutputTokens,
              maxDurationMs: this.runtime.prGuardOrchestrationMaxDurationMs,
              maxConcurrentAgents: this.runtime.prGuardOrchestrationMaxConcurrentAgents,
            },
          })
        : runPrReview(snapshot, this.runtime, { model: options.model, trace: options.trace, signal: options.signal, longTermMemory }))
      const result = redactReviewResult(await memory.applyHistoricalFeedback(reviewed))
      await this.persistence.saveReview({ jobId: options.jobId, snapshot, result })
      await memory.recordReview(snapshot, result)
      return result
    } catch (error) {
      await memory.recordFailure(snapshot, 'review', error)
      throw error
    }
  }

  async resume(runId: string, multiAgent = false): Promise<{ trace: PrGuardTrace; result: ReviewResult }> {
    return resumePrGuardReview({ runId, runtime: this.runtime, multiAgent, checkpointManager: this.checkpointManager })
  }
}

export class RepairService {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly persistence: ReviewPersistence = createDefaultReviewPersistence(runtime.prGuardMySqlUrl),
    private readonly memoryBaseDir?: string,
  ) {}

  generate(
    snapshot: PrDiffSnapshot,
    review: ReviewResult,
    findingIds: string[],
    trace?: PrGuardTrace,
  ): Promise<Patch> {
    return this.generateAndPersist(snapshot, review, findingIds, trace)
  }

  private async generateAndPersist(snapshot: PrDiffSnapshot, review: ReviewResult, findingIds: string[], trace?: PrGuardTrace): Promise<Patch> {
    await this.persistence.saveReview({ snapshot, result: review })
    const patch = await generatePatch(snapshot, review, findingIds, this.runtime, { trace })
    await this.persistence.savePatch(review.reviewId, {
      ...patch,
      summary: redactSensitiveText(patch.summary),
      unifiedDiff: redactSensitiveText(patch.unifiedDiff),
    })
    await new PrGuardMemoryService(snapshot.input.cwd, this.memoryBaseDir).recordPatch(patch, review.reviewId)
    return patch
  }

  apply(
    cwd: string,
    patch: Patch,
    testCommand: string,
    trace?: PrGuardTrace,
  ): Promise<PatchApplicationResult> {
    return this.applyAndRemember(cwd, patch, testCommand, trace)
  }

  /** Generate, verify, and retry a repair using bounded verification feedback. */
  async repair(
    snapshot: PrDiffSnapshot,
    review: ReviewResult,
    findingIds: string[],
    testCommand: string,
    options: { maxAttempts?: number; trace?: PrGuardTrace } = {},
  ) {
    return repairWithVerificationRetries(
      async ({ attempt, previous }) => {
        const patch = await generatePatch(snapshot, review, findingIds, this.runtime, {
          trace: options.trace,
          verificationFeedback: previous?.verificationOutput,
        })
        await this.persistence.savePatch(review.reviewId, {
          ...patch,
          summary: redactSensitiveText(patch.summary),
          unifiedDiff: redactSensitiveText(patch.unifiedDiff),
        })
        await options.trace?.record('checkpoint', {
          phase: 'repair_candidate_generated',
          attempt,
          hasPreviousVerificationFeedback: Boolean(previous),
        })
        return patch
      },
      patch => this.applyAndRemember(snapshot.input.cwd, patch, testCommand, options.trace),
      { maxAttempts: options.maxAttempts },
    )
  }

  async recordFindingDecisions(
    cwd: string,
    review: ReviewResult,
    findingIds: string[],
    decision: FindingDecision,
    reason?: string,
  ): Promise<void> {
    const memory = new PrGuardMemoryService(cwd, this.memoryBaseDir)
    await Promise.all(findingIds.map(findingId =>
      memory.recordFindingDecision(review, findingId, decision, reason),
    ))
  }

  private async applyAndRemember(cwd: string, patch: Patch, testCommand: string, trace?: PrGuardTrace): Promise<PatchApplicationResult> {
    const result = await applyAndVerifyPatch(cwd, patch, testCommand, {
      trace,
      verificationTimeoutMs: this.runtime.prGuardVerificationTimeoutMs,
      sandbox: {
        mode: this.runtime.prGuardSandboxMode ?? 'docker',
        image: this.runtime.prGuardSandboxImage ?? 'node:22-alpine',
        memoryMb: this.runtime.prGuardSandboxMemoryMb ?? 512,
        cpus: this.runtime.prGuardSandboxCpus ?? 1,
        pidsLimit: this.runtime.prGuardSandboxPidsLimit ?? 128,
        maxOutputBytes: this.runtime.prGuardSandboxMaxOutputBytes ?? 1024 * 1024,
      },
      patchLimits: {
        maxBytes: this.runtime.prGuardPatchMaxBytes,
        maxFiles: this.runtime.prGuardPatchMaxFiles,
      },
    })
    await new PrGuardMemoryService(cwd, this.memoryBaseDir).recordPatch(patch, undefined, result)
    return result
  }
}

export class TraceService {
  constructor(private readonly baseDir?: string) {}

  create(input: PrDiffSnapshot['input']): Promise<PrGuardTrace> {
    return createPrGuardTrace(input, { baseDir: this.baseDir })
  }

  list(): Promise<PrGuardTraceSummary[]> {
    return listPrGuardTraces(this.baseDir)
  }

  load(runId: string): Promise<PrGuardTraceEvent[]> {
    return loadPrGuardTrace(runId, this.baseDir)
  }

  replay(events: PrGuardTraceEvent[]): string {
    return replayPrGuardTrace(events)
  }
}

export class EvaluationService {
  async evaluate(options: {
    datasetPath: string
    predictionsPath?: string
    source: 'baseline' | 'predictions'
  }): Promise<EvalReport> {
    const predictions: EvalPrediction[] | undefined = options.predictionsPath
      ? await loadEvalPredictions(options.predictionsPath)
      : undefined
    return evaluateDataset({
      datasetPath: options.datasetPath,
      predictions,
      source: options.source,
    })
  }

  format(report: EvalReport): string {
    return formatEvalReport(report)
  }

  compare(candidate: EvalReport, baseline: EvalReport): EvalComparison {
    return compareEvalReports(candidate, baseline)
  }

  gate(candidate: EvalReport, baseline?: EvalReport, options?: EvalGateOptions): EvalGateResult {
    return evaluateGate(candidate, baseline, options)
  }
}
