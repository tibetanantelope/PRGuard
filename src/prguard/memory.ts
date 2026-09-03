import crypto from 'node:crypto'
import { AgentMemoryManager } from '../memory/manager.js'
import type { FindingFeedback, LongTermMemoryItem } from '../memory/types.js'
import type { Finding, Patch, PrDiffSnapshot, ReviewResult } from './types.js'
import type { PatchApplicationResult } from './repair.js'
import { redactSensitiveText } from './redaction.js'

export type FindingDecision = FindingFeedback['metadata']['decision']
export type PrGuardMemoryAction = 'read' | 'write' | 'feedback' | 'archive'
export type PrGuardMemoryAccessPolicy = {
  authorize(projectId: string, action: PrGuardMemoryAction): void | Promise<void>
}

const allowAllMemoryAccess: PrGuardMemoryAccessPolicy = {
  authorize: () => undefined,
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function findingMemoryKey(finding: Pick<Finding, 'category' | 'file' | 'title'>): string {
  return hash(`${finding.category}\n${finding.file.toLowerCase()}\n${finding.title.toLowerCase().replace(/\s+/g, ' ').trim()}`)
}

export function redactMemoryText(value: string): string {
  return redactSensitiveText(value)
}

function summarize(result: ReviewResult): ReviewResult['summary'] {
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of result.findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  return { totalFindings: result.findings.length, bySeverity, byCategory }
}

export class PrGuardMemoryService {
  readonly manager: AgentMemoryManager

  constructor(
    readonly cwd: string,
    baseDir?: string,
    private readonly accessPolicy: PrGuardMemoryAccessPolicy = allowAllMemoryAccess,
  ) {
    this.manager = new AgentMemoryManager(cwd, baseDir)
  }

  async retrieveForReview(snapshot: PrDiffSnapshot): Promise<LongTermMemoryItem[]> {
    await this.accessPolicy.authorize(this.manager.projectId, 'read')
    const query = [
      snapshot.changedFiles.map(file => file.path).join(' '),
      snapshot.diffText.slice(0, 2_000),
    ].join('\n')
    return this.manager.retrieve(query)
  }

  async applyHistoricalFeedback(result: ReviewResult): Promise<ReviewResult> {
    await this.accessPolicy.authorize(this.manager.projectId, 'read')
    const records = await this.manager.feedback.list(this.manager.projectId)
    const latest = new Map<string, FindingFeedback>()
    for (const record of records as FindingFeedback[]) {
      const key = typeof record.metadata?.findingKey === 'string' ? record.metadata.findingKey : undefined
      if (key && !latest.has(key)) latest.set(key, record)
    }
    const findings = result.findings.flatMap(finding => {
      const feedback = latest.get(findingMemoryKey(finding))
      if (!feedback) return [finding]
      if (feedback.metadata.decision === 'rejected') return []
      if (feedback.metadata.decision === 'accepted') {
        return [{ ...finding, confidence: Math.min(0.99, finding.confidence + 0.05) }]
      }
      return [{
        ...finding,
        reason: feedback.metadata.reason
          ? `${finding.reason}\nHuman feedback: ${feedback.metadata.reason}`
          : finding.reason,
      }]
    })
    const adjusted = { ...result, findings }
    return { ...adjusted, summary: summarize(adjusted) }
  }

  async recordReview(snapshot: PrDiffSnapshot, result: ReviewResult): Promise<void> {
    await this.accessPolicy.authorize(this.manager.projectId, 'write')
    const changedFileKey = snapshot.changedFiles.map(file => file.path.toLowerCase()).sort().join('|') || 'no-files'
    await this.manager.episodic.remember({
      id: `review-${hash(result.reviewId)}`,
      projectId: this.manager.projectId,
      content: redactMemoryText(`PR review ${result.reviewId}: ${result.findings.length} findings in ${snapshot.changedFiles.map(file => file.path).join(', ') || 'no changed files'}`),
      source: 'agent', category: 'pr-review', tags: ['review', ...new Set(result.findings.map(item => item.category))],
      confidence: 0.9, createdAt: result.createdAt,
      provenance: {
        generatedBy: 'agent-observation', reviewId: result.reviewId,
        observedAt: result.createdAt,
      },
      metadata: {
        reviewId: result.reviewId,
        findingCount: result.findings.length,
        githubRef: snapshot.input.githubRef,
        semanticKey: `pr-review:${changedFileKey}`,
      },
    })
    await Promise.all(result.findings.map(finding => this.manager.semantic.remember({
      id: `finding-${findingMemoryKey(finding)}`,
      projectId: this.manager.projectId,
      content: redactMemoryText(`${finding.category}/${finding.severity} ${finding.file}:${finding.lineStart}-${finding.lineEnd} ${finding.title}. ${finding.reason} Suggested fix: ${finding.suggestedFix}`),
      source: 'agent', category: finding.category, tags: ['finding', finding.severity],
      confidence: finding.confidence, createdAt: result.createdAt,
      provenance: {
        generatedBy: 'agent-observation', reviewId: result.reviewId, findingId: finding.id,
        evidenceRefs: finding.evidence.map(item => `${item.file}:${item.lineStart}-${item.lineEnd}`),
        observedAt: result.createdAt,
      },
      metadata: { reviewId: result.reviewId, findingId: finding.id, findingKey: findingMemoryKey(finding), conflictKey: findingMemoryKey(finding), status: finding.status },
    })))
    await this.manager.reinforceLastRetrieval('successful')
    await this.manager.consolidate()
    await this.manager.governCapacity()
  }

  async recordFailure(snapshot: PrDiffSnapshot, stage: string, error: unknown): Promise<void> {
    await this.accessPolicy.authorize(this.manager.projectId, 'write')
    await this.manager.episodic.remember({
      projectId: this.manager.projectId,
      content: redactMemoryText(`PRGuard ${stage} failed for ${snapshot.changedFiles.map(file => file.path).join(', ') || 'unknown files'}: ${error instanceof Error ? error.message : String(error)}`),
      source: 'system', category: 'failure', tags: ['prguard', 'failed', stage], confidence: 1,
      createdAt: new Date().toISOString(),
      metadata: {
        stage,
        semanticKey: `failure:${stage}:${snapshot.changedFiles.map(file => file.path.toLowerCase()).sort().join('|') || 'unknown'}`,
      },
      provenance: { generatedBy: 'system-event', observedAt: new Date().toISOString() },
    })
    await this.manager.reinforceLastRetrieval('failed')
    await this.manager.consolidate()
    await this.manager.governCapacity()
  }

  async recordPatch(patch: Patch, reviewId?: string, application?: PatchApplicationResult): Promise<void> {
    await this.accessPolicy.authorize(this.manager.projectId, 'write')
    const status = application?.patch.status ?? patch.status
    const verification = application?.verification
    await this.manager.episodic.remember({
      id: `patch-${hash(`${reviewId ?? ''}:${patch.findingIds.join(',')}`)}`,
      projectId: this.manager.projectId,
      content: redactMemoryText(`Patch ${status}: ${patch.summary}; findings=${patch.findingIds.join(', ')}; files=${patch.files.join(', ')}${verification ? `; test=${verification.status}; command=${verification.command}; result=${verification.output.slice(0, 500)}` : ''}`),
      source: 'agent', category: 'patch', tags: ['patch', status, verification?.status ?? 'unverified'],
      confidence: verification?.status === 'passed' ? 1 : 0.85, createdAt: new Date().toISOString(),
      provenance: {
        generatedBy: 'agent-observation', reviewId,
        evidenceRefs: patch.files,
        observedAt: new Date().toISOString(),
      },
      metadata: {
        reviewId,
        findingIds: patch.findingIds,
        status,
        verificationStatus: verification?.status,
        timedOut: verification?.timedOut,
        semanticKey: `patch:${patch.files.map(file => file.toLowerCase()).sort().join('|')}:${status}`,
      },
    })
    await this.manager.consolidate()
    await this.manager.governCapacity()
  }

  async recordFindingDecision(review: ReviewResult, findingId: string, decision: FindingDecision, reason?: string): Promise<FindingFeedback> {
    await this.accessPolicy.authorize(this.manager.projectId, 'feedback')
    const finding = review.findings.find(item => item.id === findingId)
    if (!finding) throw new Error(`Finding not found in review ${review.reviewId}: ${findingId}`)
    const key = findingMemoryKey(finding)
    const feedback = await this.manager.rememberFeedback({
      id: `feedback-${key}`,
      projectId: this.manager.projectId,
      content: redactMemoryText(`Human ${decision} finding ${finding.title} in ${finding.file}${reason ? `: ${reason}` : ''}`),
      source: 'human', category: finding.category, tags: ['finding-feedback', decision], confidence: 1,
      createdAt: new Date().toISOString(),
      provenance: {
        generatedBy: 'human-feedback', reviewId: review.reviewId, findingId,
        observedAt: new Date().toISOString(),
      },
      metadata: { findingId, findingKey: key, conflictKey: key, reviewId: review.reviewId, decision, reason: reason ? redactMemoryText(reason) : undefined },
    })
    await this.manager.governCapacity()
    return feedback
  }

  async archive(kind: LongTermMemoryItem['kind'], id: string, archivedAt?: string): Promise<boolean> {
    await this.accessPolicy.authorize(this.manager.projectId, 'archive')
    const store = kind === 'episodic' ? this.manager.episodic
      : kind === 'semantic' ? this.manager.semantic
        : kind === 'procedural' ? this.manager.procedural
          : this.manager.feedback
    return store.archive(this.manager.projectId, id, archivedAt)
  }
}
