import { reviewResultSchema, type Finding, type PrDiffSnapshot, type ReviewResult } from './types.js'

export type EvidenceVerificationSummary = {
  checkedFindingCount: number
  acceptedFindingCount: number
  rejectedFindingCount: number
  rejectedFindingIds: string[]
}

function isChangedFile(snapshot: PrDiffSnapshot, file: string): boolean {
  return snapshot.changedFiles.some(changed => changed.path === file || changed.oldPath === file)
}

function hasValidEvidence(snapshot: PrDiffSnapshot, finding: Finding): boolean {
  if (!isChangedFile(snapshot, finding.file)) return false
  return finding.evidence.some(evidence => {
    if (evidence.lineStart <= 0 || evidence.lineEnd < evidence.lineStart) return false
    if (!isChangedFile(snapshot, evidence.file)) return false
    if (evidence.source === 'diff' && !snapshot.diffText.includes(evidence.content)) return false
    return true
  })
}

export function verifyReviewEvidence(
  snapshot: PrDiffSnapshot,
  result: ReviewResult,
): { result: ReviewResult; summary: EvidenceVerificationSummary } {
  const rejectedFindingIds: string[] = []
  const findings = result.findings.filter(finding => {
    const accepted = hasValidEvidence(snapshot, finding)
    if (!accepted) rejectedFindingIds.push(finding.id)
    return accepted
  })
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  const summary: EvidenceVerificationSummary = {
    checkedFindingCount: result.findings.length,
    acceptedFindingCount: findings.length,
    rejectedFindingCount: rejectedFindingIds.length,
    rejectedFindingIds,
  }
  return {
    result: reviewResultSchema.parse({
      ...result,
      findings,
      summary: {
        totalFindings: findings.length,
        bySeverity,
        byCategory,
      },
      evidenceVerification: summary,
    }),
    summary,
  }
}
