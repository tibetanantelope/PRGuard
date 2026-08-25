import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { RiskCategory, Severity } from './types.js'

export const evalExpectedFindingSchema = z.object({
  category: z.enum(['security', 'reliability', 'code_quality']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  title: z.string().min(1),
})

export type EvalExpectedFinding = z.infer<typeof evalExpectedFindingSchema>

export const evalTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  fixture: z.string().min(1),
  expected: z.string().min(1),
})

export type EvalTask = z.infer<typeof evalTaskSchema>

export const evalPredictionSchema = z.object({
  taskId: z.string().min(1),
  findings: z.array(z.object({
    category: z.enum(['security', 'reliability', 'code_quality']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    file: z.string().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    title: z.string().min(1).optional(),
  })),
  patchTestPassed: z.boolean().nullable().optional(),
  toolCalls: z.number().nonnegative().optional(),
  tokens: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  failed: z.boolean().optional(),
})

export type EvalPrediction = z.infer<typeof evalPredictionSchema>

export type EvalMatch = {
  expected: EvalExpectedFinding
  predicted: EvalPrediction['findings'][number]
}

export type EvalMetrics = {
  taskCount: number
  failedTaskCount: number
  expectedFindingCount: number
  predictedFindingCount: number
  matchedFindingCount: number
  findingPrecision: number
  findingRecall: number
  findingF1: number
  localizationAccuracy: number
  highRiskRecall: number | null
  patchTestPassRate: number | null
  averageToolCalls: number
  averageTokens: number
  averageDurationMs: number
  taskFailureRate: number
  falsePositiveCount: number
  falseNegativeCount: number
}

export type EvalReport = {
  dataset: string
  source: 'baseline' | 'predictions'
  metrics: EvalMetrics
  matches: Array<{ taskId: string; matches: EvalMatch[] }>
}

export type EvalComparison = {
  candidate: EvalMetrics
  baseline: EvalMetrics
  delta: Pick<EvalMetrics, 'findingPrecision' | 'findingRecall' | 'findingF1' | 'highRiskRecall' | 'patchTestPassRate' | 'taskFailureRate'>
  regressions: string[]
}

const severityRank: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

export async function loadJsonl<T>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
  const content = await readFile(filePath, 'utf8')
  const values: T[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const parsed = schema.safeParse(JSON.parse(line))
    if (!parsed.success) {
      throw new Error(`Invalid JSONL record at ${filePath}:${index + 1}: ${parsed.error.message}`)
    }
    values.push(parsed.data)
  }
  return values
}

export async function loadEvalDataset(datasetPath: string): Promise<EvalTask[]> {
  return loadJsonl(datasetPath, evalTaskSchema)
}

export async function loadExpectedFindings(filePath: string): Promise<EvalExpectedFinding[]> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'))
  const result = z.array(evalExpectedFindingSchema).safeParse(parsed)
  if (!result.success) {
    throw new Error(`Invalid expected findings file ${filePath}: ${result.error.message}`)
  }
  return result.data
}

export async function loadEvalPredictions(filePath: string): Promise<EvalPrediction[]> {
  return loadJsonl(filePath, evalPredictionSchema)
}

function lineRangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd + 2 && rightStart <= leftEnd + 2
}

function findMatches(
  expected: EvalExpectedFinding[],
  predicted: EvalPrediction['findings'],
): EvalMatch[] {
  const used = new Set<number>()
  const matches: EvalMatch[] = []
  for (const expectedFinding of expected) {
    const index = predicted.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false
      return candidate.category === expectedFinding.category
        && candidate.file === expectedFinding.file
        && lineRangesOverlap(candidate.lineStart, candidate.lineEnd, expectedFinding.lineStart, expectedFinding.lineEnd)
    })
    if (index !== -1) {
      used.add(index)
      matches.push({ expected: expectedFinding, predicted: predicted[index]! })
    }
  }
  return matches
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

export function calculateEvalMetrics(
  expectedByTask: Map<string, EvalExpectedFinding[]>,
  predictions: EvalPrediction[],
): Pick<EvalReport, 'metrics' | 'matches'> {
  const allExpected = [...expectedByTask.values()].flat()
  const matches = predictions.map(prediction => ({
    taskId: prediction.taskId,
    matches: findMatches(expectedByTask.get(prediction.taskId) ?? [], prediction.findings),
  }))
  const matched = matches.reduce((sum, entry) => sum + entry.matches.length, 0)
  const precision = ratio(matched, predictions.reduce((sum, entry) => sum + entry.findings.length, 0))
  const recall = ratio(matched, allExpected.length)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const localizationAccuracy = ratio(matched, allExpected.length)
  const highRiskExpected = allExpected.filter(finding => severityRank[finding.severity] >= severityRank.high)
  const highRiskMatched = matches
    .flatMap(entry => entry.matches)
    .filter(match => severityRank[match.expected.severity] >= severityRank.high)
    .length
  const patchValues = predictions
    .map(prediction => prediction.patchTestPassed)
    .filter((value): value is boolean => value !== undefined && value !== null)
  const numberAverage = (selector: (prediction: EvalPrediction) => number | undefined): number => {
    const values = predictions.map(selector).filter((value): value is number => value !== undefined)
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  return {
    metrics: {
      taskCount: predictions.length,
      failedTaskCount: predictions.filter(prediction => prediction.failed).length,
      expectedFindingCount: allExpected.length,
      predictedFindingCount: predictions.reduce((sum, entry) => sum + entry.findings.length, 0),
      matchedFindingCount: matched,
      findingPrecision: precision,
      findingRecall: recall,
      findingF1: f1,
      localizationAccuracy,
      highRiskRecall: highRiskExpected.length === 0 ? null : highRiskMatched / highRiskExpected.length,
      patchTestPassRate: patchValues.length === 0
        ? null
        : patchValues.filter(Boolean).length / patchValues.length,
      averageToolCalls: numberAverage(prediction => prediction.toolCalls),
      averageTokens: numberAverage(prediction => prediction.tokens),
      averageDurationMs: numberAverage(prediction => prediction.durationMs),
      taskFailureRate: ratio(predictions.filter(prediction => prediction.failed).length, predictions.length),
      falsePositiveCount: Math.max(0, predictions.reduce((sum, entry) => sum + entry.findings.length, 0) - matched),
      falseNegativeCount: Math.max(0, allExpected.length - matched),
    },
    matches,
  }
}

export function compareEvalReports(candidate: EvalReport, baseline: EvalReport): EvalComparison {
  const delta = {
    findingPrecision: candidate.metrics.findingPrecision - baseline.metrics.findingPrecision,
    findingRecall: candidate.metrics.findingRecall - baseline.metrics.findingRecall,
    findingF1: candidate.metrics.findingF1 - baseline.metrics.findingF1,
    highRiskRecall: subtractNullable(candidate.metrics.highRiskRecall, baseline.metrics.highRiskRecall),
    patchTestPassRate: subtractNullable(candidate.metrics.patchTestPassRate, baseline.metrics.patchTestPassRate),
    taskFailureRate: candidate.metrics.taskFailureRate - baseline.metrics.taskFailureRate,
  }
  const regressions: string[] = []
  if (delta.findingF1 < 0) regressions.push('findingF1')
  if (delta.highRiskRecall !== null && delta.highRiskRecall < 0) regressions.push('highRiskRecall')
  if (delta.taskFailureRate > 0) regressions.push('taskFailureRate')
  return { candidate: candidate.metrics, baseline: baseline.metrics, delta, regressions }
}

function subtractNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right
}

function addedLines(diffText: string): Array<{ file: string; line: number; text: string }> {
  const lines = diffText.split(/\r?\n/)
  const result: Array<{ file: string; line: number; text: string }> = []
  let file = ''
  let currentLine = 0
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      currentLine = Number(hunk[1])
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      result.push({ file, line: currentLine, text: line.slice(1) })
      currentLine += 1
      continue
    }
    if (!line.startsWith('-') && !line.startsWith('diff --git') && currentLine > 0) {
      currentLine += 1
    }
  }
  return result
}

function baselineFinding(
  category: RiskCategory,
  severity: Severity,
  file: string,
  line: number,
  title: string,
): EvalPrediction['findings'][number] {
  return { category, severity, file, lineStart: line, lineEnd: line, title }
}

export function runRuleBaseline(diffText: string): EvalPrediction['findings'] {
  const findings: EvalPrediction['findings'] = []
  for (const entry of addedLines(diffText)) {
    const text = entry.text
    if (/\b(exec|spawn|system)\s*\([^)]*(input|query|user|request|params)/i.test(text)) {
      findings.push(baselineFinding('security', 'high', entry.file, entry.line, 'Untrusted input reaches command execution'))
    } else if (/\b(SELECT|UPDATE|DELETE|INSERT)\b.*(\+|\$\{|format\(|f['"])/i.test(text)) {
      findings.push(baselineFinding('security', 'high', entry.file, entry.line, 'SQL query is built from dynamic input'))
    } else if (/(path\.join|resolve)\s*\([^)]*(input|user|request|params)/i.test(text)) {
      findings.push(baselineFinding('security', 'high', entry.file, entry.line, 'User-controlled path may escape its base directory'))
    } else if (/catch\s*\([^)]*\)\s*\{\s*\}/i.test(text) || /catch\s*\{\s*\}/i.test(text)) {
      findings.push(baselineFinding('reliability', 'medium', entry.file, entry.line, 'Exception is swallowed without handling'))
    } else if (/TODO|FIXME/i.test(text)) {
      findings.push(baselineFinding('code_quality', 'low', entry.file, entry.line, 'Changed code contains an unresolved marker'))
    }
  }
  return findings
}

export async function buildBaselinePredictions(
  datasetPath: string,
  tasks?: EvalTask[],
): Promise<EvalPrediction[]> {
  const predictions: EvalPrediction[] = []
  const datasetDir = path.dirname(datasetPath)
  for (const task of tasks ?? await loadEvalDataset(datasetPath)) {
    const diffText = await readFile(path.resolve(datasetDir, task.fixture), 'utf8')
    const startedAt = performance.now()
    const findings = runRuleBaseline(diffText)
    predictions.push({
      taskId: task.id,
      findings,
      toolCalls: 0,
      tokens: 0,
      durationMs: Math.max(0, performance.now() - startedAt),
      failed: false,
      patchTestPassed: null,
    })
  }
  return predictions
}

export async function evaluateDataset(options: {
  datasetPath: string
  predictions?: EvalPrediction[]
  source: 'baseline' | 'predictions'
}): Promise<EvalReport> {
  const tasks = await loadEvalDataset(options.datasetPath)
  const datasetDir = path.dirname(options.datasetPath)
  const expectedByTask = new Map<string, EvalExpectedFinding[]>()
  for (const task of tasks) {
    expectedByTask.set(task.id, await loadExpectedFindings(path.resolve(datasetDir, task.expected)))
  }
  const predictions = options.predictions ?? await buildBaselinePredictions(options.datasetPath, tasks)
  const calculated = calculateEvalMetrics(expectedByTask, predictions)
  return {
    dataset: options.datasetPath,
    source: options.source,
    ...calculated,
  }
}

export function formatEvalReport(report: EvalReport): string {
  const formatPercent = (value: number | null): string => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
  const { metrics } = report
  return [
    `PRGuard offline evaluation (${report.source})`,
    `Dataset: ${report.dataset}`,
    '',
    `Tasks: ${metrics.taskCount}  Failed: ${metrics.failedTaskCount}`,
    `Findings: expected=${metrics.expectedFindingCount} predicted=${metrics.predictedFindingCount} matched=${metrics.matchedFindingCount}`,
    `Precision: ${formatPercent(metrics.findingPrecision)}  Recall: ${formatPercent(metrics.findingRecall)}  F1: ${formatPercent(metrics.findingF1)}`,
    `Localization accuracy: ${formatPercent(metrics.localizationAccuracy)}`,
    `High-risk recall: ${formatPercent(metrics.highRiskRecall)}`,
    `Patch test pass rate: ${formatPercent(metrics.patchTestPassRate)}`,
    `Average tool calls: ${metrics.averageToolCalls.toFixed(1)}  Average tokens: ${metrics.averageTokens.toFixed(0)}`,
    `Average duration: ${metrics.averageDurationMs.toFixed(1)} ms  Task failure rate: ${formatPercent(metrics.taskFailureRate)}`,
    `False positives: ${metrics.falsePositiveCount}  False negatives: ${metrics.falseNegativeCount}`,
  ].join('\n')
}
