import type { ModelAdapter } from '../types.js'
import type { RuntimeConfig } from '../config.js'
import { runMultiAgentPrReview } from './multi-review.js'
import { runPrReview } from './review.js'
import type { PrGuardTrace } from './trace.js'
import type { PrDiffSnapshot, ReviewResult } from './types.js'

export type AdaptiveReviewResult = ReviewResult & {
  routing: {
    strategy: 'adaptive'
    escalated: boolean
    reasons: string[]
  }
}

function routeReasons(snapshot: PrDiffSnapshot, review: ReviewResult): string[] {
  const reasons: string[] = []
  const riskText = snapshot.diffText.toLowerCase()
  const categories = new Set(review.findings.map(finding => finding.category))
  if (review.findings.some(finding => finding.severity === 'high' || finding.severity === 'critical')) {
    reasons.push('high_risk_finding')
  }
  if (review.findings.some(finding => finding.confidence < 0.75)) {
    reasons.push('low_confidence_finding')
  }
  if (review.findings.length >= 2 || categories.size >= 2) {
    reasons.push('multiple_findings_or_categories')
  }
  const riskSignals = [
    /\b(exec|spawn|system|shell)\s*\(/,
    /\b(select|insert|update|delete)\b.*(\+|\$\{|concat|format)/,
    /path\.(join|resolve)\s*\(/,
    /https?:\/\/|fetch\s*\(/,
    /catch\s*\([^)]*\)\s*\{\s*\}/,
    /\b(retry|for\s*\([^)]*attempt)/,
  ]
  if (riskSignals.filter(signal => signal.test(riskText)).length >= 2) {
    reasons.push('multi_risk_diff')
  }
  return reasons
}

export async function runAdaptivePrReview(
  snapshot: PrDiffSnapshot,
  runtime: RuntimeConfig,
  options: { model?: ModelAdapter; maxSteps?: number; trace?: PrGuardTrace; signal?: AbortSignal } = {},
): Promise<AdaptiveReviewResult> {
  await options.trace?.record('checkpoint', { phase: 'adaptive_route_started', strategy: 'single_then_escalate' })
  const initial = await runPrReview(snapshot, runtime, {
    model: options.model,
    maxSteps: options.maxSteps,
    trace: options.trace,
    signal: options.signal,
    evidenceVerification: false,
  })
  const reasons = routeReasons(snapshot, initial)
  if (reasons.length === 0) {
    const result = { ...initial, routing: { strategy: 'adaptive' as const, escalated: false, reasons } }
    await options.trace?.record('checkpoint', { phase: 'adaptive_route_completed', escalated: false, reasons })
    return result
  }
  await options.trace?.record('checkpoint', { phase: 'adaptive_route_escalated', escalated: true, reasons })
  const escalated = await runMultiAgentPrReview(snapshot, runtime, {
    model: options.model,
    maxSteps: options.maxSteps,
    trace: options.trace,
    signal: options.signal,
    evidenceVerification: true,
  })
  return {
    ...escalated,
    routing: { strategy: 'adaptive', escalated: true, reasons },
  }
}
