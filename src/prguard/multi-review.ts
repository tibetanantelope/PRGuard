import { randomUUID } from 'node:crypto'
import { reviewResultSchema, findingSchema, type Finding, type PrDiffSnapshot, type ReviewResult, type Severity } from './types.js'
import type { ModelAdapter } from '../types.js'
import type { RuntimeConfig } from '../config.js'
import { runPrReview } from './review.js'
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
  failed?: string
}

export type MultiAgentReviewResult = ReviewResult & {
  agents: MultiAgentReport[]
  aggregation: {
    inputFindingCount: number
    deduplicatedFindingCount: number
    supportedFindingCount: number
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
): MultiAgentReviewResult {
  const findings: Finding[] = []
  const support = new Map<string, number>()
  const inputFindingCount = reviews.reduce((sum, review) => sum + review.findings.length, 0)
  for (const review of reviews) {
    for (const finding of review.findings) {
      const existingIndex = findings.findIndex(existing => overlaps(existing, finding))
      if (existingIndex === -1) {
        findings.push(findingSchema.parse({ ...finding, id: `finding-${findings.length + 1}` }))
        support.set(findings.at(-1)!.id, 1)
      } else {
        const existing = findings[existingIndex]!
        const count = (support.get(existing.id) ?? 1) + 1
        findings[existingIndex] = mergeFinding(existing, finding, count)
        support.set(existing.id, count)
      }
    }
  }

  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  const result = reviewResultSchema.parse({
    schemaVersion: '0.1',
    reviewId: randomUUID(),
    createdAt: new Date().toISOString(),
    input: snapshot.input,
    findings,
    summary: {
      totalFindings: findings.length,
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
      supportedFindingCount: [...support.values()].filter(count => count > 1).length,
    },
  }
}

export async function runMultiAgentPrReview(
  snapshot: PrDiffSnapshot,
  runtime: RuntimeConfig,
  options: { model?: ModelAdapter; maxSteps?: number; trace?: PrGuardTrace } = {},
): Promise<MultiAgentReviewResult> {
  const settled = await Promise.allSettled(prGuardAgentRoles.map(role =>
    runPrReview(snapshot, runtime, {
      model: options.model,
      maxSteps: options.maxSteps,
      trace: options.trace,
      role: role.name,
      skillName: role.skillName,
      focus: role.focus,
    }),
  ))
  const reviews: ReviewResult[] = []
  const reports: MultiAgentReport[] = []
  settled.forEach((result, index) => {
    const role = prGuardAgentRoles[index]!
    if (result.status === 'fulfilled') {
      reviews.push(result.value)
      reports.push({ role: role.name, findingCount: result.value.findings.length })
    } else {
      reports.push({
        role: role.name,
        findingCount: 0,
        failed: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  })
  if (reviews.length === 0) {
    throw new Error('All PRGuard specialist agents failed.')
  }
  const aggregated = aggregateAgentReviews(snapshot, reviews, reports)
  await options.trace?.record('review_completed', {
    result: aggregated,
    mode: 'multi_agent',
    agentCount: reports.length,
    findingCount: aggregated.findings.length,
    supportedFindingCount: aggregated.aggregation.supportedFindingCount,
  })
  return aggregated
}
