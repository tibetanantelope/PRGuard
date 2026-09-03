import type { Finding } from '../prguard/types.js'
import type { SpecialistRoute } from './router.js'

export type BlackboardFinding = {
  agentId: string
  finding: Finding
  recordedAt: string
}

export type BlackboardSnapshot = {
  version: number
  findings: BlackboardFinding[]
  completedAgents: string[]
  failedAgents: string[]
  selectedAgents: string[]
  skippedAgents: string[]
  conflicts: BlackboardConflict[]
  judgments: BlackboardJudgment[]
}

export type BlackboardConflict = {
  id: string
  findingIds: string[]
  agentIds: string[]
  reason: string
}

export type BlackboardJudgment = {
  findingId: string
  decision: 'accepted' | 'rejected'
  reason: string
  judge: string
  recordedAt: string
}

/** Append-only coordination state shared by parallel review specialists. */
export class ReviewBlackboard {
  private versionValue = 0
  private readonly findingsValue: BlackboardFinding[] = []
  private readonly completedAgentsValue = new Set<string>()
  private readonly failedAgentsValue = new Set<string>()
  private readonly selectedAgentsValue = new Set<string>()
  private readonly skippedAgentsValue = new Set<string>()
  private readonly judgmentsValue: BlackboardJudgment[] = []

  recordRoute(route: SpecialistRoute): void {
    route.selected.forEach(role => this.selectedAgentsValue.add(role.name))
    route.skipped.forEach(role => this.skippedAgentsValue.add(role.name))
    this.versionValue += 1
  }

  recordFindings(agentId: string, findings: Finding[], now = new Date().toISOString()): void {
    for (const finding of findings) this.findingsValue.push({ agentId, finding, recordedAt: now })
    this.completedAgentsValue.add(agentId)
    this.failedAgentsValue.delete(agentId)
    this.versionValue += 1
  }

  recordFailure(agentId: string): void {
    this.failedAgentsValue.add(agentId)
    this.versionValue += 1
  }

  recordJudgments(judgments: Omit<BlackboardJudgment, 'recordedAt'>[], now = new Date().toISOString()): void {
    this.judgmentsValue.push(...judgments.map(judgment => ({ ...judgment, recordedAt: now })))
    if (judgments.length > 0) this.versionValue += 1
  }

  conflicts(): BlackboardConflict[] {
    const conflicts: BlackboardConflict[] = []
    for (let leftIndex = 0; leftIndex < this.findingsValue.length; leftIndex += 1) {
      const left = this.findingsValue[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < this.findingsValue.length; rightIndex += 1) {
        const right = this.findingsValue[rightIndex]!
        if (left.agentId === right.agentId || left.finding.file !== right.finding.file) continue
        const overlaps = left.finding.lineStart <= right.finding.lineEnd + 2
          && right.finding.lineStart <= left.finding.lineEnd + 2
        if (!overlaps) continue
        const disagrees = left.finding.category !== right.finding.category
          || left.finding.severity !== right.finding.severity
          || left.finding.suggestedFix.trim().toLowerCase() !== right.finding.suggestedFix.trim().toLowerCase()
        if (!disagrees) continue
        conflicts.push({
          id: `conflict-${conflicts.length + 1}`,
          findingIds: [left.finding.id, right.finding.id],
          agentIds: [left.agentId, right.agentId],
          reason: 'Overlapping findings disagree on category, severity, or remediation.',
        })
      }
    }
    return conflicts
  }

  snapshot(): BlackboardSnapshot {
    return {
      version: this.versionValue,
      findings: this.findingsValue.map(item => ({ ...item })),
      completedAgents: [...this.completedAgentsValue],
      failedAgents: [...this.failedAgentsValue],
      selectedAgents: [...this.selectedAgentsValue],
      skippedAgents: [...this.skippedAgentsValue],
      conflicts: this.conflicts(),
      judgments: this.judgmentsValue.map(item => ({ ...item })),
    }
  }
}
