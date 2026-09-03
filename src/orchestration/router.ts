import type { PrDiffSnapshot, RiskCategory } from '../prguard/types.js'

export type SpecialistRole = {
  name: string
  skillName: string
  category: RiskCategory
  focus: string
}

export const prGuardAgentRoles: readonly SpecialistRole[] = [
  {
    name: 'Security Agent',
    skillName: 'prguard-security',
    category: 'security',
    focus: 'injection, authorization, path traversal, secrets, unsafe deserialization, and trust-boundary violations',
  },
  {
    name: 'Reliability Agent',
    skillName: 'prguard-reliability',
    category: 'reliability',
    focus: 'exception handling, retries, timeouts, resource cleanup, concurrency, and boundary conditions',
  },
  {
    name: 'Code Quality Agent',
    skillName: 'prguard-code-quality',
    category: 'code_quality',
    focus: 'regressions, maintainability, test gaps, API compatibility, and duplicated or fragile logic',
  },
] as const

export type SpecialistRoute = {
  selected: SpecialistRole[]
  skipped: SpecialistRole[]
  reasons: Record<string, string[]>
  riskSignals: string[]
}

const securityPatterns: Array<[string, RegExp]> = [
  ['auth_or_permission', /\b(auth|authorize|permission|rbac|acl|session|jwt|token)\b/i],
  ['command_or_code_execution', /\b(?:exec|spawn|eval)\s*\(|new\s+Function\s*\(/i],
  ['injection_or_secret', /\b(select|insert|update|delete)\b.*(?:\+|\$\{)|password|api[_-]?key|secret/i],
  ['filesystem_boundary', /path\.(?:join|resolve)|\.\.\//i],
]

const reliabilityPatterns: Array<[string, RegExp]> = [
  ['failure_handling', /\b(?:try|catch|throw|error|failure)\b/i],
  ['retry_or_timeout', /\b(?:retry|backoff|timeout|abort)\b/i],
  ['concurrency', /\b(?:promise|async|await|worker|queue|lock|transaction|concurr)/i],
  ['resource_lifecycle', /\b(?:stream|socket|connection|close|dispose|cleanup)\b/i],
]

function matches(text: string, patterns: Array<[string, RegExp]>): string[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

export function routePrGuardSpecialists(
  snapshot: PrDiffSnapshot,
  options: { maxSpecialists?: number } = {},
): SpecialistRoute {
  const maxSpecialists = Math.max(1, Math.min(prGuardAgentRoles.length, options.maxSpecialists ?? prGuardAgentRoles.length))
  const fileText = snapshot.changedFiles.map(file => file.path).join('\n')
  const input = `${fileText}\n${snapshot.diffText}`
  const securityReasons = matches(input, securityPatterns)
  const reliabilityReasons = matches(input, reliabilityPatterns)
  const changedLines = snapshot.changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const uncertain = snapshot.diffText.trim().length < 20
  const broadChange = changedLines >= 500 || snapshot.changedFiles.length >= 20
  const selectedNames = new Set<string>()
  const reasons: Record<string, string[]> = {}

  if (securityReasons.length > 0 || uncertain || broadChange) {
    selectedNames.add('Security Agent')
    reasons['Security Agent'] = securityReasons.length > 0 ? securityReasons : [uncertain ? 'insufficient_diff_context' : 'broad_change']
  }
  if (reliabilityReasons.length > 0 || uncertain || broadChange) {
    selectedNames.add('Reliability Agent')
    reasons['Reliability Agent'] = reliabilityReasons.length > 0 ? reliabilityReasons : [uncertain ? 'insufficient_diff_context' : 'broad_change']
  }
  selectedNames.add('Code Quality Agent')
  reasons['Code Quality Agent'] = ['baseline_regression_review']

  const candidates = prGuardAgentRoles.filter(role => selectedNames.has(role.name))
  const selected = candidates.slice(0, maxSpecialists)
  const selectedSet = new Set(selected.map(role => role.name))
  return {
    selected,
    skipped: prGuardAgentRoles.filter(role => !selectedSet.has(role.name)),
    reasons,
    riskSignals: [...new Set([...securityReasons, ...reliabilityReasons, ...(broadChange ? ['broad_change'] : []), ...(uncertain ? ['insufficient_diff_context'] : [])])],
  }
}
