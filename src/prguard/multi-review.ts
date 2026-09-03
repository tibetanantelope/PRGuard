import { randomUUID } from 'node:crypto'
import { reviewResultSchema, findingSchema, type Finding, type PrDiffSnapshot, type ReviewResult, type Severity } from './types.js'
import type { ModelAdapter } from '../types.js'
import type { RuntimeConfig } from '../config.js'
import { AnthropicModelAdapter } from '../anthropic-adapter.js'
import { ToolRegistry } from '../tool.js'
import { runPrReview } from './review.js'
import { verifyReviewEvidenceSelective } from './evidence-verifier.js'
import { withTraceModel, type PrGuardTrace } from './trace.js'
import { ReviewBlackboard, type BlackboardSnapshot } from '../orchestration/blackboard.js'
import type { CheckpointManager } from '../runtime/checkpoint.js'
import { hashJson } from '../runtime/ids.js'
import type { LongTermMemoryItem } from '../memory/types.js'
import { OrchestrationBudgetController, type OrchestrationBudget, type OrchestrationUsage } from '../orchestration/budget.js'
import { runReviewJudge, type ReviewJudgeResult } from '../orchestration/judge.js'
import { SpecialistRuntime } from '../orchestration/specialist-runtime.js'
import { routePrGuardSpecialists } from '../orchestration/router.js'
export { prGuardAgentRoles } from '../orchestration/router.js'

export type MultiAgentReport = {
  agentId?: string
  role: string
  findingCount: number
  attempts?: number
  durationMs?: number
  fallback?: boolean
  failed?: string
  degraded?: boolean
  checkpointRunId?: string
  resumed?: boolean
}

export type MultiAgentReviewResult = ReviewResult & {
  agents: MultiAgentReport[]
  aggregation: {
    inputFindingCount: number
    deduplicatedFindingCount: number
    supportedFindingCount: number
    categoryRejectedFindingCount: number
    categoryMismatchAcceptedFindingCount: number
    suppressedFindingCount: number
    fallbackUsed: boolean
    unsupportedFindingIds: string[]
    blackboardVersion: number
    failedAgentIds: string[]
    criticReviewedFindingCount?: number
    criticRejectedFindingCount?: number
    conflictCount?: number
  }
  orchestration?: {
    route: {
      selectedAgents: string[]
      skippedAgents: string[]
      reasons: Record<string, string[]>
      riskSignals: string[]
    }
    budget: OrchestrationUsage & { elapsedMs: number; remainingModelCalls: number }
    judge: Pick<ReviewJudgeResult, 'mode' | 'reviewedFindingIds' | 'rejectedFindingIds' | 'conflictCount' | 'modelError'>
    blackboard: BlackboardSnapshot
  }
}

const severityRank: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

function overlaps(left: Finding, right: Finding): boolean {
  return left.category === right.category
    && left.file === right.file
    && left.lineStart <= right.lineEnd + 2
    && right.lineStart <= left.lineEnd + 2
}

function allowedCategoryForRole(role: string): Finding['category'] | undefined {
  if (role === 'Security Agent') return 'security'
  if (role === 'Reliability Agent') return 'reliability'
  if (role === 'Code Quality Agent') return 'code_quality'
  return undefined
}

function meetsAggregationGate(finding: Finding, supportCount: number): boolean {
  // Preserve recall for actionable risks. Less severe findings need corroboration
  // unless the originating agent is exceptionally confident.
  if (finding.severity === 'high' || finding.severity === 'critical') {
    return true
  }
  if (finding.severity === 'medium') return supportCount >= 2 || finding.confidence >= 0.85
  return supportCount >= 2 || finding.confidence >= 0.9
}

function mergeFinding(current: Finding, candidate: Finding, supportCount: number): Finding {
  const primary = candidate.confidence > current.confidence ? candidate : current
  const evidence = [...current.evidence, ...candidate.evidence]
    .filter((item, index, all) => all.findIndex(other =>
      other.file === item.file
      && other.lineStart === item.lineStart
      && other.lineEnd === item.lineEnd
      && other.content === item.content,
    ) === index)
  return findingSchema.parse({
    ...primary,
    id: current.id,
    severity: severityRank[candidate.severity] > severityRank[current.severity]
      ? candidate.severity
      : current.severity,
    confidence: Math.min(0.99, Math.max(current.confidence, candidate.confidence) + Math.min(0.15, supportCount * 0.05)),
    evidence,
  })
}

export function aggregateAgentReviews(
  snapshot: PrDiffSnapshot,
  reviews: ReviewResult[],
  agentReports: MultiAgentReport[],
  options: { fallbackUsed?: boolean; blackboard?: ReviewBlackboard } = {},
): MultiAgentReviewResult {
  const findings: Finding[] = []
  const support = new Map<string, Set<string>>()
  const inputFindingCount = reviews.reduce((sum, review) => sum + review.findings.length, 0)
  let categoryRejectedFindingCount = 0
  let categoryMismatchAcceptedFindingCount = 0
  const successfulReports = agentReports.filter(report => !report.failed)
  reviews.forEach((review, reviewIndex) => {
    const role = successfulReports[reviewIndex]?.role ?? `agent-${reviewIndex + 1}`
    const allowedCategory = allowedCategoryForRole(role)
    for (const finding of review.findings) {
      if (allowedCategory && finding.category !== allowedCategory) {
        if (finding.severity === 'high' || finding.severity === 'critical') {
          categoryMismatchAcceptedFindingCount += 1
        } else {
          categoryRejectedFindingCount += 1
          continue
        }
      }
      const existingIndex = findings.findIndex(existing => overlaps(existing, finding))
      if (existingIndex === -1) {
        findings.push(findingSchema.parse({
          ...finding,
          id: `finding-${findings.length + 1}`,
          provenance: {
            sourceAgents: [role],
            supportCount: 1,
            aggregationReason: 'first observation from specialist',
          },
        }))
        support.set(findings.at(-1)!.id, new Set([role]))
      } else {
        const existing = findings[existingIndex]!
        const roles = support.get(existing.id) ?? new Set([role])
        roles.add(role)
        const count = roles.size
        findings[existingIndex] = findingSchema.parse({
          ...mergeFinding(existing, finding, count),
          provenance: {
            sourceAgents: [...roles],
            supportCount: count,
            aggregationReason: count > 1 ? 'corroborated by independent specialists' : 'single specialist observation',
          },
        })
        support.set(existing.id, roles)
      }
    }
  })

  const gatedFindings = findings.filter(finding => meetsAggregationGate(finding, support.get(finding.id)?.size ?? 1))
  const suppressedFindingCount = findings.length - gatedFindings.length

  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of gatedFindings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  const result = reviewResultSchema.parse({
    schemaVersion: '0.1',
    reviewId: randomUUID(),
    createdAt: new Date().toISOString(),
    input: snapshot.input,
    findings: gatedFindings,
    summary: {
      totalFindings: gatedFindings.length,
      bySeverity,
      byCategory,
    },
  })
  return {
    ...result,
    agents: agentReports,
    aggregation: {
      inputFindingCount,
      deduplicatedFindingCount: findings.length,
      supportedFindingCount: [...support.values()].filter(roles => roles.size > 1).length,
      categoryRejectedFindingCount,
      categoryMismatchAcceptedFindingCount,
      suppressedFindingCount,
      fallbackUsed: options.fallbackUsed === true,
      unsupportedFindingIds: gatedFindings
        .filter(finding => (support.get(finding.id)?.size ?? 1) < 2)
        .map(finding => finding.id),
      blackboardVersion: options.blackboard?.snapshot().version ?? 0,
      failedAgentIds: agentReports.filter(report => report.failed).map(report => report.agentId ?? report.role),
    },
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  return results
}

export async function runMultiAgentPrReview(
  snapshot: PrDiffSnapshot,
  runtime: RuntimeConfig,
  options: {
    model?: ModelAdapter
    maxSteps?: number
    trace?: PrGuardTrace
    signal?: AbortSignal
    evidenceVerification?: boolean
    specialistRetries?: number
    specialistTimeoutMs?: number
    checkpointManager?: CheckpointManager
    runtimeInputHash?: string
    longTermMemory?: LongTermMemoryItem[]
    maxSpecialists?: number
    orchestrationBudget?: Partial<OrchestrationBudget>
    criticJudge?: boolean
    judgeModel?: ModelAdapter
  } = {},
): Promise<MultiAgentReviewResult> {
  const blackboard = new ReviewBlackboard()
  const route = routePrGuardSpecialists(snapshot, {
    maxSpecialists: options.maxSpecialists ?? runtime.prGuardMaxSpecialists,
  })
  blackboard.recordRoute(route)
  const retries = Math.max(0, options.specialistRetries ?? 1)
  const timeoutMs = options.specialistTimeoutMs ?? runtime.prGuardReviewTimeoutMs ?? 120_000
  const budget = new OrchestrationBudgetController({
    maxModelCalls: options.orchestrationBudget?.maxModelCalls
      ?? runtime.prGuardOrchestrationMaxModelCalls
      ?? route.selected.length * (options.maxSteps ?? 12) * (retries + 1) + 2,
    maxInputTokens: options.orchestrationBudget?.maxInputTokens ?? runtime.prGuardOrchestrationMaxInputTokens,
    maxOutputTokens: options.orchestrationBudget?.maxOutputTokens ?? runtime.prGuardOrchestrationMaxOutputTokens,
    maxDurationMs: options.orchestrationBudget?.maxDurationMs
      ?? runtime.prGuardOrchestrationMaxDurationMs
      ?? Math.max(1_000, timeoutMs * (retries + 2)),
    maxConcurrentAgents: options.orchestrationBudget?.maxConcurrentAgents
      ?? runtime.prGuardOrchestrationMaxConcurrentAgents
      ?? route.selected.length,
  })
  const baseModel = options.model ?? new AnthropicModelAdapter(new ToolRegistry([]), async () => runtime)
  const budgetedModel = budget.wrap(baseModel)
  await options.trace?.record('checkpoint', {
    phase: 'agent_plan_created',
    strategy: 'dynamic_route_blackboard_critic_judge',
    selectedRoles: route.selected.map(role => ({ name: role.name, skillName: role.skillName, focus: role.focus, capabilities: role.capabilities })),
    skippedRoles: route.skipped.map(role => role.name),
    routeReasons: route.reasons,
    riskSignals: route.riskSignals,
    budget: budget.budget,
  })
  const checkpointManager = options.checkpointManager
  const reviewInputHash = options.runtimeInputHash ?? hashJson({
    input: snapshot.input,
    diffText: snapshot.diffText,
    model: runtime.model,
    longTermMemory: options.longTermMemory?.map(item => ({
      id: item.id,
      content: item.content,
      confidence: item.confidence,
    })),
    selectedRoles: route.selected.map(role => role.name),
    pipeline: 'prguard-specialists-v3',
  })
  const specialistRuntime = new SpecialistRuntime()
  const settled = await mapWithConcurrency(
    route.selected,
    budget.budget.maxConcurrentAgents,
    async role => {
    const messagesRef = `prguard-specialist:${reviewInputHash}:${role.name}`
    const outcome = await specialistRuntime.run<ReviewResult>({
      specialistId: role.name,
      goal: `${snapshot.input.cwd}:${role.name}`,
      taskId: `specialist-${role.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      messagesRef,
      inputHash: reviewInputHash,
      retries,
      timeoutMs,
      signal: options.signal,
      checkpointManager,
      budget,
      recover: outputs => {
        const parsed = reviewResultSchema.safeParse(outputs?.review)
        return parsed.success ? parsed.data : undefined
      },
      serialize: review => ({ review }),
      execute: (_attempt, signal) => runPrReview(snapshot, runtime, {
        model: budgetedModel,
        maxSteps: options.maxSteps,
        trace: options.trace,
        signal,
        evidenceVerification: false,
        role: role.name,
        skillName: role.skillName,
        focus: role.focus,
        capabilities: role.capabilities,
        longTermMemory: options.longTermMemory,
      }),
      onEvent: async event => {
        if (event.phase === 'attempt_failed') blackboard.recordFailure(role.name)
        await options.trace?.record('checkpoint', {
          phase: `specialist_${event.phase}`,
          role: role.name,
          attempt: event.attempt,
          timeoutMs,
          durationMs: event.durationMs,
          retrying: event.retrying,
          checkpointRunId: event.checkpointRunId,
          error: event.error,
        })
      },
    })
    if (outcome.value) {
      blackboard.recordFindings(role.name, outcome.value.findings)
      return {
        review: outcome.value,
        report: {
          agentId: role.name, role: role.name, findingCount: outcome.value.findings.length,
          attempts: outcome.attempts, durationMs: outcome.durationMs,
          checkpointRunId: outcome.checkpointRunId, resumed: outcome.resumed,
        } as MultiAgentReport,
      }
    }
    return {
      report: {
        agentId: role.name,
        role: role.name,
        findingCount: 0,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        failed: outcome.error,
        degraded: true,
      } as MultiAgentReport,
    }
  })
  const reviews: ReviewResult[] = []
  const reports: MultiAgentReport[] = []
  settled.forEach(result => {
    if ('review' in result && result.review) reviews.push(result.review)
    reports.push(result.report)
  })
  await options.trace?.record('checkpoint', {
    phase: 'agent_plan_completed',
    roles: reports,
    successfulAgents: reviews.length,
  })
  if (reviews.length === 0) {
    if (options.signal?.aborted) throw new Error('PRGuard multi-agent review was cancelled.')
    await options.trace?.record('checkpoint', {
      phase: 'specialist_fallback_started',
      reason: 'all_specialists_failed',
    })
    try {
      const fallback = await runPrReview(snapshot, runtime, {
        model: budgetedModel,
        maxSteps: options.maxSteps,
        trace: options.trace,
        signal: options.signal,
        evidenceVerification: options.evidenceVerification,
        longTermMemory: options.longTermMemory,
      })
      reviews.push(fallback)
       reports.push({ agentId: 'single-agent-fallback', role: 'Single-Agent Fallback', findingCount: fallback.findings.length, attempts: 1, fallback: true, degraded: true })
      await options.trace?.record('checkpoint', {
        phase: 'specialist_fallback_succeeded',
        findingCount: fallback.findings.length,
      })
    } catch (error) {
      await options.trace?.record('checkpoint', {
        phase: 'specialist_fallback_failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error('All PRGuard specialist agents and the Single-Agent fallback failed.')
    }
  }
  const aggregated = aggregateAgentReviews(snapshot, reviews, reports, {
    fallbackUsed: reports.some(report => report.fallback === true),
    blackboard,
  })
  const criticJudgeEnabled = options.criticJudge ?? runtime.prGuardCriticJudgeEnabled ?? true
  const judgeBaseModel = !criticJudgeEnabled
    ? undefined
    : options.judgeModel
      ? budget.wrap(options.judgeModel)
      : budgetedModel
  const judgeModel = judgeBaseModel && options.trace
    ? withTraceModel(judgeBaseModel, options.trace)
    : judgeBaseModel
  const judgment = await runReviewJudge({
    snapshot,
    result: aggregated,
    blackboard,
    unsupportedFindingIds: aggregated.aggregation.unsupportedFindingIds,
    model: judgeModel,
    signal: options.signal,
  })
  let finalResult: MultiAgentReviewResult = {
    ...judgment.result,
    agents: aggregated.agents,
    aggregation: {
      ...aggregated.aggregation,
      blackboardVersion: blackboard.snapshot().version,
      criticReviewedFindingCount: judgment.reviewedFindingIds.length,
      criticRejectedFindingCount: judgment.rejectedFindingIds.length,
      conflictCount: judgment.conflictCount,
    },
    orchestration: {
      route: {
        selectedAgents: route.selected.map(role => role.name),
        skippedAgents: route.skipped.map(role => role.name),
        reasons: route.reasons,
        riskSignals: route.riskSignals,
      },
      budget: budget.snapshot(),
      judge: {
        mode: judgment.mode,
        reviewedFindingIds: judgment.reviewedFindingIds,
        rejectedFindingIds: judgment.rejectedFindingIds,
        conflictCount: judgment.conflictCount,
        modelError: judgment.modelError,
      },
      blackboard: blackboard.snapshot(),
    },
  }
  await options.trace?.record('checkpoint', {
    phase: 'critic_judge_completed',
    mode: judgment.mode,
    reviewedFindingIds: judgment.reviewedFindingIds,
    rejectedFindingIds: judgment.rejectedFindingIds,
    conflictCount: judgment.conflictCount,
    modelError: judgment.modelError,
    blackboardVersion: blackboard.snapshot().version,
  })
  if (options.evidenceVerification) {
    const selectedFindingIds = [
      ...aggregated.aggregation.unsupportedFindingIds,
      ...aggregated.findings
        .filter(finding => finding.confidence < 0.8)
        .map(finding => finding.id),
    ]
    const verification = verifyReviewEvidenceSelective(snapshot, finalResult, {
      findingIds: [...new Set(selectedFindingIds)],
    })
    finalResult = {
      ...verification.result,
      agents: finalResult.agents,
      aggregation: finalResult.aggregation,
      orchestration: finalResult.orchestration,
    }
    await options.trace?.record('checkpoint', {
      phase: 'selective_evidence_verification',
      selectedFindingCount: verification.summary.checkedFindingCount,
      acceptedFindingCount: verification.summary.acceptedFindingCount,
      rejectedFindingCount: verification.summary.rejectedFindingCount,
      rejectedFindingIds: verification.summary.rejectedFindingIds,
    })
  }
  await options.trace?.record('review_completed', {
    result: finalResult,
    mode: 'multi_agent',
    agentCount: reports.length,
    findingCount: finalResult.findings.length,
    supportedFindingCount: finalResult.aggregation.supportedFindingCount,
    categoryRejectedFindingCount: finalResult.aggregation.categoryRejectedFindingCount,
    categoryMismatchAcceptedFindingCount: finalResult.aggregation.categoryMismatchAcceptedFindingCount,
    suppressedFindingCount: finalResult.aggregation.suppressedFindingCount,
    criticRejectedFindingCount: finalResult.aggregation.criticRejectedFindingCount,
    conflictCount: finalResult.aggregation.conflictCount,
    route: finalResult.orchestration?.route,
    budget: budget.snapshot(),
  })
  return finalResult
}
