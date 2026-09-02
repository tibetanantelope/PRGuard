import { randomUUID } from 'node:crypto'
import { reviewResultSchema, findingSchema, type Finding, type PrDiffSnapshot, type ReviewResult, type Severity } from './types.js'
import type { ModelAdapter } from '../types.js'
import type { RuntimeConfig } from '../config.js'
import { runPrReview } from './review.js'
import { verifyReviewEvidenceSelective } from './evidence-verifier.js'
import type { PrGuardTrace } from './trace.js'

export const prGuardAgentRoles = [
  {
    name: 'Security Agent',
    skillName: 'prguard-security',
    focus: 'injection, authorization, path traversal, secrets, unsafe deserialization, and trust-boundary violations',
  },
  {
    name: 'Reliability Agent',
    skillName: 'prguard-reliability',
    focus: 'exception handling, retries, timeouts, resource cleanup, concurrency, and boundary conditions',
  },
  {
    name: 'Code Quality Agent',
    skillName: 'prguard-code-quality',
    focus: 'regressions, maintainability, test gaps, API compatibility, and duplicated or fragile logic',
  },
] as const

export type MultiAgentReport = {
  role: string
  findingCount: number
  attempts?: number
  durationMs?: number
  fallback?: boolean
  failed?: string
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
  options: { fallbackUsed?: boolean } = {},
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
        findings.push(findingSchema.parse({ ...finding, id: `finding-${findings.length + 1}` }))
        support.set(findings.at(-1)!.id, new Set([role]))
      } else {
        const existing = findings[existingIndex]!
        const roles = support.get(existing.id) ?? new Set([role])
        roles.add(role)
        const count = roles.size
        findings[existingIndex] = mergeFinding(existing, finding, count)
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
    },
  }
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
  } = {},
): Promise<MultiAgentReviewResult> {
  await options.trace?.record('checkpoint', {
    phase: 'agent_plan_created',
    strategy: 'parallel_specialists_then_aggregation',
    roles: prGuardAgentRoles.map(role => ({ name: role.name, skillName: role.skillName, focus: role.focus })),
  })
  const retries = Math.max(0, options.specialistRetries ?? 1)
  const timeoutMs = options.specialistTimeoutMs ?? runtime.prGuardReviewTimeoutMs ?? 120_000
  const settled = await Promise.all(prGuardAgentRoles.map(async role => {
    const startedAt = performance.now()
    let lastError: unknown
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await options.trace?.record('checkpoint', {
          phase: 'specialist_attempt_started',
          role: role.name,
          attempt,
          timeoutMs,
        })
        const reviewPromise = runPrReview(snapshot, runtime, {
          model: options.model,
          maxSteps: options.maxSteps,
          trace: options.trace,
          signal: controller.signal,
          evidenceVerification: false,
          role: role.name,
          skillName: role.skillName,
          focus: role.focus,
        })
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error(`${role.name} timed out after ${timeoutMs} ms.`))
          }, timeoutMs)
        })
        const review = await Promise.race([reviewPromise, timeoutPromise])
        await options.trace?.record('checkpoint', {
          phase: 'specialist_attempt_succeeded',
          role: role.name,
          attempt,
          durationMs: Math.round(performance.now() - startedAt),
        })
        return { review, report: { role: role.name, findingCount: review.findings.length, attempts: attempt, durationMs: Math.round(performance.now() - startedAt) } as MultiAgentReport }
      } catch (error) {
        lastError = error
        await options.trace?.record('checkpoint', {
          phase: 'specialist_attempt_failed',
          role: role.name,
          attempt,
          retrying: attempt <= retries && !options.signal?.aborted,
          error: error instanceof Error ? error.message : String(error),
        })
        if (options.signal?.aborted) break
      } finally {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
    }
    return {
      error: lastError,
      report: {
        role: role.name,
        findingCount: 0,
        attempts: retries + 1,
        durationMs: Math.round(performance.now() - startedAt),
        failed: lastError instanceof Error ? lastError.message : String(lastError),
      } as MultiAgentReport,
    }
  }))
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
        model: options.model,
        maxSteps: options.maxSteps,
        trace: options.trace,
        signal: options.signal,
        evidenceVerification: options.evidenceVerification,
      })
      reviews.push(fallback)
      reports.push({ role: 'Single-Agent Fallback', findingCount: fallback.findings.length, attempts: 1, fallback: true })
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
  })
  let finalResult = aggregated
  if (options.evidenceVerification) {
    const selectedFindingIds = [
      ...aggregated.aggregation.unsupportedFindingIds,
      ...aggregated.findings
        .filter(finding => finding.confidence < 0.8)
        .map(finding => finding.id),
    ]
    const verification = verifyReviewEvidenceSelective(snapshot, aggregated, {
      findingIds: [...new Set(selectedFindingIds)],
    })
    finalResult = {
      ...verification.result,
      agents: aggregated.agents,
      aggregation: aggregated.aggregation,
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
  })
  return finalResult
}
