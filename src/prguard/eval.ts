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

export const evalSplitSchema = z.enum(['validation', 'holdout'])
export const evalDifficultySchema = z.enum(['easy', 'medium', 'hard'])
export const evalRiskCategorySchema = z.enum(['security', 'reliability', 'code_quality'])
export const evalRepairSchema = z.object({
  required: z.boolean(),
  fixture: z.string().min(1).optional(),
  verificationCommand: z.string().min(1).optional(),
  expectedOutcome: z.enum(['not_applicable', 'must_apply_and_pass', 'must_reject']).default('not_applicable'),
}).superRefine((repair, context) => {
  if (repair.required && !repair.fixture) {
    context.addIssue({ code: 'custom', path: ['fixture'], message: 'A repair fixture is required when repair.required=true.' })
  }
  if (!repair.required && repair.expectedOutcome !== 'not_applicable') {
    context.addIssue({ code: 'custom', path: ['expectedOutcome'], message: 'Non-repair tasks must use expectedOutcome=not_applicable.' })
  }
})

export const evalTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  datasetVersion: z.string().regex(/^v\d+$/, 'datasetVersion must look like v1'),
  split: evalSplitSchema,
  riskCategories: z.array(evalRiskCategorySchema).min(1),
  difficulty: evalDifficultySchema,
  repair: evalRepairSchema,
  fixture: z.string().min(1),
  expected: z.string().min(1),
})

export type EvalTask = z.infer<typeof evalTaskSchema>
export type EvalSplit = z.infer<typeof evalSplitSchema>
export type EvalDifficulty = z.infer<typeof evalDifficultySchema>

export type EvalDatasetSummary = {
  datasetVersion: string
  taskCount: number
  validationTaskCount: number
  holdoutTaskCount: number
  repairTaskCount: number
  categoryCounts: Record<z.infer<typeof evalRiskCategorySchema>, number>
  difficultyCounts: Record<EvalDifficulty, number>
}

export const evalPredictionSchema = z.object({
  taskId: z.string().min(1),
  split: evalSplitSchema.optional(),
  runId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
  traceRunId: z.string().min(1).optional(),
  findings: z.array(z.object({
    category: z.enum(['security', 'reliability', 'code_quality']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    file: z.string().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    title: z.string().min(1).optional(),
  })),
  patchTestPassed: z.boolean().nullable().optional(),
  repairAttempted: z.boolean().optional(),
  patchGenerated: z.boolean().optional(),
  patchApplied: z.boolean().optional(),
  rollbackVerified: z.boolean().optional(),
  endToEndRepairSuccess: z.boolean().optional(),
  toolCalls: z.number().nonnegative().optional(),
  tokens: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  adaptiveEscalated: z.boolean().optional(),
  verifierInvoked: z.boolean().optional(),
  verifierCheckedFindingCount: z.number().int().nonnegative().optional(),
  verifierRejectedFindingCount: z.number().int().nonnegative().optional(),
  fallbackUsed: z.boolean().optional(),
  specialistCount: z.number().int().nonnegative().optional(),
  specialistFailureCount: z.number().int().nonnegative().optional(),
  failed: z.boolean().optional(),
  failureReason: z.string().min(1).optional(),
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
  repairTaskCount: number
  patchGenerationSuccessRate: number | null
  patchApplySuccessRate: number | null
  rollbackVerificationRate: number | null
  endToEndRepairSuccessRate: number | null
  averageToolCalls: number
  averageTokens: number
  averageDurationMs: number
  adaptiveTaskCount: number
  adaptiveEscalatedTaskCount: number
  adaptiveEscalationRate: number | null
  verifierTaskCount: number
  verifierInvocationRate: number | null
  verifierCheckedFindingCount: number
  verifierRejectedFindingCount: number
  fallbackTaskCount: number
  fallbackRate: number
  specialistFailureCount: number
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

export type EvalGateOptions = {
  minFindingF1?: number
  minHighRiskRecall?: number
  maxTaskFailureRate?: number
  minPatchTestPassRate?: number
  failOnBaselineRegression?: boolean
}

export type EvalGateResult = {
  passed: boolean
  failures: string[]
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
  const tasks = await loadJsonl(datasetPath, evalTaskSchema)
  validateEvalDataset(tasks, datasetPath)
  return tasks
}

export function validateEvalDataset(tasks: EvalTask[], datasetPath = 'evaluation dataset'): void {
  if (tasks.length === 0) throw new Error(`Evaluation dataset is empty: ${datasetPath}`)
  const ids = new Set<string>()
  const versions = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate evaluation task id: ${task.id}`)
    ids.add(task.id)
    versions.add(task.datasetVersion)
  }
  if (versions.size !== 1) {
    throw new Error(`Evaluation dataset must contain exactly one datasetVersion: ${[...versions].join(', ')}`)
  }
  if (!tasks.some(task => task.split === 'validation')) throw new Error('Evaluation dataset must contain validation tasks.')
  if (!tasks.some(task => task.split === 'holdout')) throw new Error('Evaluation dataset must contain holdout tasks.')
}

export function summarizeEvalDataset(tasks: EvalTask[]): EvalDatasetSummary {
  validateEvalDataset(tasks)
  const categoryCounts: EvalDatasetSummary['categoryCounts'] = { security: 0, reliability: 0, code_quality: 0 }
  const difficultyCounts: EvalDatasetSummary['difficultyCounts'] = { easy: 0, medium: 0, hard: 0 }
  for (const task of tasks) {
    for (const category of task.riskCategories) categoryCounts[category] += 1
    difficultyCounts[task.difficulty] += 1
  }
  return {
    datasetVersion: tasks[0]!.datasetVersion,
    taskCount: tasks.length,
    validationTaskCount: tasks.filter(task => task.split === 'validation').length,
    holdoutTaskCount: tasks.filter(task => task.split === 'holdout').length,
    repairTaskCount: tasks.filter(task => task.repair.required).length,
    categoryCounts,
    difficultyCounts,
  }
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
  const repairPredictions = predictions.filter(prediction => prediction.repairAttempted === true)
  const repairRatio = (selector: (prediction: EvalPrediction) => boolean | undefined): number | null => {
    if (repairPredictions.length === 0) return null
    return repairPredictions.filter(prediction => selector(prediction) === true).length / repairPredictions.length
  }
  const numberAverage = (selector: (prediction: EvalPrediction) => number | undefined): number => {
    const values = predictions.map(selector).filter((value): value is number => value !== undefined)
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const adaptivePredictions = predictions.filter(prediction => prediction.adaptiveEscalated !== undefined)
  const adaptiveEscalatedTaskCount = adaptivePredictions.filter(prediction => prediction.adaptiveEscalated === true).length
  const verifierTaskCount = predictions.filter(prediction => prediction.verifierInvoked === true).length
  const fallbackTaskCount = predictions.filter(prediction => prediction.fallbackUsed === true).length
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
      repairTaskCount: repairPredictions.length,
      patchGenerationSuccessRate: repairRatio(prediction => prediction.patchGenerated),
      patchApplySuccessRate: repairRatio(prediction => prediction.patchApplied),
      rollbackVerificationRate: repairRatio(prediction => prediction.rollbackVerified),
      endToEndRepairSuccessRate: repairRatio(prediction => prediction.endToEndRepairSuccess),
      averageToolCalls: numberAverage(prediction => prediction.toolCalls),
      averageTokens: numberAverage(prediction => prediction.tokens),
      averageDurationMs: numberAverage(prediction => prediction.durationMs),
      adaptiveTaskCount: adaptivePredictions.length,
      adaptiveEscalatedTaskCount,
      adaptiveEscalationRate: adaptivePredictions.length === 0 ? null : adaptiveEscalatedTaskCount / adaptivePredictions.length,
      verifierTaskCount,
      verifierInvocationRate: predictions.length === 0 ? null : verifierTaskCount / predictions.length,
      verifierCheckedFindingCount: predictions.reduce((sum, prediction) => sum + (prediction.verifierCheckedFindingCount ?? 0), 0),
      verifierRejectedFindingCount: predictions.reduce((sum, prediction) => sum + (prediction.verifierRejectedFindingCount ?? 0), 0),
      fallbackTaskCount,
      fallbackRate: ratio(fallbackTaskCount, predictions.length),
      specialistFailureCount: predictions.reduce((sum, prediction) => sum + (prediction.specialistFailureCount ?? 0), 0),
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
      repairAttempted: task.repair.required,
      patchGenerated: false,
      patchApplied: false,
      rollbackVerified: false,
      endToEndRepairSuccess: false,
    })
  }
  return predictions
}

export async function evaluateDataset(options: {
  datasetPath: string
  predictions?: EvalPrediction[]
  source: 'baseline' | 'predictions'
  split?: EvalSplit
}): Promise<EvalReport> {
  const allTasks = await loadEvalDataset(options.datasetPath)
  const tasks = options.split ? allTasks.filter(task => task.split === options.split) : allTasks
  if (tasks.length === 0) throw new Error(`Evaluation dataset has no ${options.split} tasks.`)
  const datasetDir = path.dirname(options.datasetPath)
  const expectedByTask = new Map<string, EvalExpectedFinding[]>()
  for (const task of tasks) {
    expectedByTask.set(task.id, await loadExpectedFindings(path.resolve(datasetDir, task.expected)))
  }
  const predictions = (options.predictions ?? await buildBaselinePredictions(options.datasetPath, tasks))
    .filter(prediction => tasks.some(task => task.id === prediction.taskId))
  const taskIds = new Set(tasks.map(task => task.id))
  const predictionIds = new Set<string>()
  for (const prediction of predictions) {
    if (!taskIds.has(prediction.taskId)) {
      throw new Error(`Prediction references unknown evaluation task: ${prediction.taskId}`)
    }
    if (predictionIds.has(prediction.taskId)) {
      throw new Error(`Duplicate evaluation prediction for task: ${prediction.taskId}`)
    }
    predictionIds.add(prediction.taskId)
  }
  const missing = tasks.map(task => task.id).filter(taskId => !predictionIds.has(taskId))
  if (missing.length > 0) {
    throw new Error(`Missing evaluation predictions for task(s): ${missing.join(', ')}`)
  }
  const calculated = calculateEvalMetrics(expectedByTask, predictions)
  return {
    dataset: options.split ? `${options.datasetPath}#${options.split}` : options.datasetPath,
    source: options.source,
    ...calculated,
  }
}

export function evaluateGate(
  candidate: EvalReport,
  baseline?: EvalReport,
  options: EvalGateOptions = {},
): EvalGateResult {
  const failures: string[] = []
  const metrics = candidate.metrics
  const checkMin = (name: string, value: number | null, threshold: number | undefined): void => {
    if (threshold === undefined || value === null) return
    if (value < threshold) failures.push(`${name}=${value.toFixed(4)} < minimum ${threshold.toFixed(4)}`)
  }
  const checkMax = (name: string, value: number, threshold: number | undefined): void => {
    if (threshold === undefined) return
    if (value > threshold) failures.push(`${name}=${value.toFixed(4)} > maximum ${threshold.toFixed(4)}`)
  }
  checkMin('findingF1', metrics.findingF1, options.minFindingF1)
  checkMin('highRiskRecall', metrics.highRiskRecall, options.minHighRiskRecall)
  checkMin('patchTestPassRate', metrics.patchTestPassRate, options.minPatchTestPassRate)
  checkMax('taskFailureRate', metrics.taskFailureRate, options.maxTaskFailureRate)

  if (baseline && options.failOnBaselineRegression !== false) {
    const comparison = compareEvalReports(candidate, baseline)
    for (const regression of comparison.regressions) {
      failures.push(`baseline regression: ${regression}`)
    }
  }
  return { passed: failures.length === 0, failures }
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
    `Repair tasks: ${metrics.repairTaskCount}  Patch generation: ${formatPercent(metrics.patchGenerationSuccessRate)}  Patch apply: ${formatPercent(metrics.patchApplySuccessRate)}`,
    `Rollback verified: ${formatPercent(metrics.rollbackVerificationRate)}  End-to-end repair: ${formatPercent(metrics.endToEndRepairSuccessRate)}`,
    `Average tool calls: ${metrics.averageToolCalls.toFixed(1)}  Average tokens: ${metrics.averageTokens.toFixed(0)}`,
    `Average duration: ${metrics.averageDurationMs.toFixed(1)} ms  Task failure rate: ${formatPercent(metrics.taskFailureRate)}`,
    `Strategy: adaptive=${metrics.adaptiveTaskCount} escalated=${metrics.adaptiveEscalatedTaskCount} (${formatPercent(metrics.adaptiveEscalationRate)})  verifierRuns=${metrics.verifierTaskCount} (${formatPercent(metrics.verifierInvocationRate)})`,
    `Verifier findings checked: ${metrics.verifierCheckedFindingCount}  rejected: ${metrics.verifierRejectedFindingCount}  Fallback tasks: ${metrics.fallbackTaskCount} (${formatPercent(metrics.fallbackRate)})  Specialist failures: ${metrics.specialistFailureCount}`,
    `False positives: ${metrics.falsePositiveCount}  False negatives: ${metrics.falseNegativeCount}`,
  ].join('\n')
}
