import type { RuntimeConfig } from '../config.js'
import {
  applyAndVerifyPatch,
  generatePatch,
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
import { compareEvalReports, evaluateDataset, formatEvalReport, loadEvalPredictions, type EvalComparison, type EvalPrediction, type EvalReport } from './eval.js'
import { runMultiAgentPrReview } from './multi-review.js'
import { resumePrGuardReview } from './recovery.js'
import { runPrReview } from './review.js'
import type { Patch, PrDiffSnapshot, ReviewResult } from './types.js'
import { createDefaultReviewPersistence, type ReviewPersistence } from './review-persistence.js'

export class ReviewService {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly persistence: ReviewPersistence = createDefaultReviewPersistence(runtime.prGuardMySqlUrl),
  ) {}

  async review(
    snapshot: PrDiffSnapshot,
    options: { multiAgent?: boolean; trace?: PrGuardTrace; jobId?: string } = {},
  ): Promise<ReviewResult> {
    const result = await (options.multiAgent
      ? runMultiAgentPrReview(snapshot, this.runtime, { trace: options.trace })
      : runPrReview(snapshot, this.runtime, { trace: options.trace }))
    await this.persistence.saveReview({ jobId: options.jobId, snapshot, result })
    return result
  }

  async resume(runId: string, multiAgent = false): Promise<{ trace: PrGuardTrace; result: ReviewResult }> {
    return resumePrGuardReview({ runId, runtime: this.runtime, multiAgent })
  }
}

export class RepairService {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly persistence: ReviewPersistence = createDefaultReviewPersistence(runtime.prGuardMySqlUrl),
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
    await this.persistence.savePatch(review.reviewId, patch)
    return patch
  }

  apply(
    cwd: string,
    patch: Patch,
    testCommand: string,
    trace?: PrGuardTrace,
  ): Promise<PatchApplicationResult> {
    return applyAndVerifyPatch(cwd, patch, testCommand, { trace })
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
}
