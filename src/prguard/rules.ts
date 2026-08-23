import { findingSchema, reviewResultSchema, type Finding, type PrDiffSnapshot, type ReviewResult } from './types.js'

type AddedLine = { file: string; line: number; content: string }

function addedLines(diffText: string): AddedLine[] {
  const result: AddedLine[] = []
  let file = ''
  let newLine = 0
  for (const line of diffText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (!file || line.startsWith('+++')) continue
    if (line.startsWith('+')) {
      result.push({ file, line: newLine, content: line.slice(1) })
      newLine += 1
    } else if (!line.startsWith('-')) {
      newLine += 1
    }
  }
  return result
}

function ruleFinding(
  id: string,
  line: AddedLine,
  title: string,
  reason: string,
  suggestedFix: string,
): Finding {
  return findingSchema.parse({
    id,
    category: 'security',
    severity: 'high',
    confidence: 1,
    status: 'open',
    file: line.file,
    lineStart: line.line,
    lineEnd: line.line,
    title,
    evidence: [{
      source: 'diff',
      file: line.file,
      lineStart: line.line,
      lineEnd: line.line,
      content: line.content,
      explanation: reason,
    }],
    reason,
    suggestedFix,
    verification: { status: 'pending', commands: [] },
  })
}

export function detectDeterministicFindings(diffText: string): Finding[] {
  const findings: Finding[] = []
  for (const line of addedLines(diffText)) {
    if (/\bexec\s*\(/.test(line.content) && !/\bexecFile\s*\(/.test(line.content)) {
      findings.push(ruleFinding(
        `RULE-EXEC-${line.file}-${line.line}`,
        line,
        'Shell-based command execution detected',
        'The added line calls exec with a command string. This is a shell execution sink and can enable command injection when input is caller-controlled.',
        'Use execFile or spawn with a fixed executable and a separate argument array, with shell disabled.',
      ))
    }
    if (/\beval\s*\(/.test(line.content)) {
      findings.push(ruleFinding(
        `RULE-EVAL-${line.file}-${line.line}`,
        line,
        'Dynamic code evaluation detected',
        'The added line evaluates a string as code. If the string is influenced by a caller, this can lead to arbitrary code execution.',
        'Remove eval and replace it with a typed parser or an allowlisted operation map.',
      ))
    }
  }
  return findings
}

export function applyDeterministicRules(result: ReviewResult, snapshot: PrDiffSnapshot): ReviewResult {
  const rules = detectDeterministicFindings(snapshot.diffText)
  const findings = [...result.findings]
  for (const candidate of rules) {
    const duplicate = findings.some(existing =>
      existing.category === candidate.category
      && existing.file === candidate.file
      && existing.lineStart <= candidate.lineEnd + 1
      && candidate.lineStart <= existing.lineEnd + 1,
    )
    if (!duplicate) findings.push(candidate)
  }
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 }
  const byCategory = { security: 0, reliability: 0, code_quality: 0 }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }
  return reviewResultSchema.parse({
    ...result,
    findings,
    summary: {
      totalFindings: findings.length,
      bySeverity,
      byCategory,
    },
  })
}
