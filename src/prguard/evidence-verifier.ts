import { reviewResultSchema, type Finding, type PrDiffSnapshot, type ReviewResult } from './types.js'

export type EvidenceVerificationSummary = {
  checkedFindingCount: number
  acceptedFindingCount: number
  rejectedFindingCount: number
  rejectedFindingIds: string[]
  rejectionReasons: Record<string, string>
}

export type SelectiveVerificationOptions = {
  findingIds?: string[]
  confidenceThreshold?: number
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

function addedDiffText(snapshot: PrDiffSnapshot): string {
  return snapshot.diffText
    .split(/\r?\n/)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n')
}

function hasSemanticContradiction(snapshot: PrDiffSnapshot, finding: Finding): string | undefined {
  const added = addedDiffText(snapshot).toLowerCase()
  const description = `${finding.title} ${finding.reason}`.toLowerCase()

  if (finding.category === 'security' && /(sql|query|injection)/.test(description)) {
    if (/\bexecute\s*\([^)]*,\s*\[[^\]]+\]|\bquery\s*\([^)]*,\s*\[[^\]]+\]/.test(added)
      || /\?\s*['"`)]?\s*[,)]/.test(added) && /\b(allowlist|parameteri[sz]|prepared statement)/.test(added)) {
      return 'SQL call contains a parameterized or prepared-statement safeguard.'
    }
  }

  if (finding.category === 'security' && /(command|shell|exec|injection)/.test(description)) {
    if (/\bexecfile\s*\(/.test(added) && /shell\s*:\s*false/.test(added)
      || /\b(allowlist|allowedcommands|commandallowlist|validcommands)\b/.test(added)) {
      return 'Command execution is constrained by a non-shell API or an explicit allowlist.'
    }
  }

  if (finding.category === 'security' && /(path|traversal|directory escape)/.test(description)) {
    if (/(startsWith|relative\s*\(|commonpath|realpath)/.test(added)
      && /base|root|directory|resolved|relative/.test(added)) {
      return 'Path handling includes a base-directory containment check.'
    }
  }

  if (finding.category === 'reliability' && /(timeout|retry|exception|error handling|swallow|cleanup)/.test(description)) {
    if (/\b(timeout|abortsignal|signal\s*:|retry|finally|catch\s*\()\b/.test(added)) {
      return 'The changed code contains an explicit timeout, retry, cleanup, or exception-handling safeguard.'
    }
  }

  return undefined
}

function shouldSelectForVerification(finding: Finding, confidenceThreshold: number): boolean {
  if (finding.confidence < confidenceThreshold) return true
  const description = `${finding.title} ${finding.reason}`.toLowerCase()
  return /(sql|query|injection|command|shell|exec|path|traversal|timeout|retry|exception|cleanup)/.test(description)
}

export function verifyReviewEvidence(
  snapshot: PrDiffSnapshot,
  result: ReviewResult,
  options: SelectiveVerificationOptions = {},
): { result: ReviewResult; summary: EvidenceVerificationSummary } {
  const rejectedFindingIds: string[] = []
  const rejectionReasons: Record<string, string> = {}
  const selectedIds = options.findingIds ? new Set(options.findingIds) : undefined
  const candidates = selectedIds
    ? result.findings.filter(finding => selectedIds.has(finding.id))
    : result.findings
  const findings = result.findings.filter(finding => {
    if (selectedIds && !selectedIds.has(finding.id)) return true
    if (!hasValidEvidence(snapshot, finding)) {
      rejectedFindingIds.push(finding.id)
      rejectionReasons[finding.id] = 'Evidence is not grounded in a changed file or the supplied diff.'
      return false
    }
    const contradiction = hasSemanticContradiction(snapshot, finding)
    if (contradiction && finding.severity !== 'critical') {
      rejectedFindingIds.push(finding.id)
      rejectionReasons[finding.id] = contradiction
      return false
    }
    const accepted = true
    return accepted
  })
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  const summary: EvidenceVerificationSummary = {
    checkedFindingCount: candidates.length,
    acceptedFindingCount: findings.length,
    rejectedFindingCount: rejectedFindingIds.length,
    rejectedFindingIds,
    rejectionReasons,
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

export function verifyReviewEvidenceSelective(
  snapshot: PrDiffSnapshot,
  result: ReviewResult,
  options: SelectiveVerificationOptions = {},
): { result: ReviewResult; summary: EvidenceVerificationSummary } {
  const confidenceThreshold = options.confidenceThreshold ?? 0.8
  const findingIds = options.findingIds ?? result.findings
    .filter(finding => shouldSelectForVerification(finding, confidenceThreshold))
    .map(finding => finding.id)
  const verified = verifyReviewEvidence(snapshot, result, { findingIds })
  return {
    result: verified.result,
    summary: {
      ...verified.summary,
      checkedFindingCount: result.findings.filter(finding => findingIds.includes(finding.id)).length,
    },
  }
}
