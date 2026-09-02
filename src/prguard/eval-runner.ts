import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  evaluateDataset,
  loadEvalDataset,
  type EvalDifficulty,
  type EvalPrediction,
  type EvalReport,
  type EvalSplit,
  type EvalTask,
} from './eval.js'

export type EvalTaskRunResult = Pick<EvalPrediction, 'findings' | 'patchTestPassed' | 'repairAttempted' | 'patchGenerated' | 'patchApplied' | 'rollbackVerified' | 'endToEndRepairSuccess' | 'toolCalls' | 'tokens' | 'traceRunId' | 'adaptiveEscalated' | 'verifierInvoked' | 'verifierCheckedFindingCount' | 'verifierRejectedFindingCount' | 'fallbackUsed' | 'specialistCount' | 'specialistFailureCount'> & {
  failed?: boolean
  failureReason?: string
}

export type EvalTaskRunContext = {
  runId: string
  task: EvalTask
  split: EvalSplit
  model: string
  promptVersion: string
}

export type EvalTaskRunner = (
  task: EvalTask,
  context: EvalTaskRunContext,
) => Promise<EvalTaskRunResult>

export type EvalExperimentManifest = {
  runId: string
  datasetPath: string
  datasetVersion: string
  split: EvalSplit | 'all'
  taskCount: number
  mode: string
  model: string
  promptVersion: string
  startedAt: string
  finishedAt: string
  durationMs: number
  failedTaskIds: string[]
}

export type EvalExperimentResult = {
  manifest: EvalExperimentManifest
  predictions: EvalPrediction[]
  report: EvalReport
  outputDir: string
}

function jsonl(values: unknown[]): string {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

function normalizeResult(result: EvalTaskRunResult | undefined): EvalTaskRunResult {
  return {
    findings: result?.findings ?? [],
    patchTestPassed: result?.patchTestPassed ?? null,
    repairAttempted: result?.repairAttempted,
    patchGenerated: result?.patchGenerated,
    patchApplied: result?.patchApplied,
    rollbackVerified: result?.rollbackVerified,
    endToEndRepairSuccess: result?.endToEndRepairSuccess,
    toolCalls: result?.toolCalls ?? 0,
    tokens: result?.tokens ?? 0,
    traceRunId: result?.traceRunId,
    adaptiveEscalated: result?.adaptiveEscalated,
    verifierInvoked: result?.verifierInvoked,
    verifierCheckedFindingCount: result?.verifierCheckedFindingCount,
    verifierRejectedFindingCount: result?.verifierRejectedFindingCount,
    fallbackUsed: result?.fallbackUsed,
    specialistCount: result?.specialistCount,
    specialistFailureCount: result?.specialistFailureCount,
    failed: result?.failed ?? false,
    failureReason: result?.failureReason,
  }
}

export async function runEvaluationExperiment(options: {
  datasetPath: string
  outputDir: string
  mode: string
  model: string
  promptVersion: string
  split?: EvalSplit
  runId?: string
  runner: EvalTaskRunner
  now?: () => Date
}): Promise<EvalExperimentResult> {
  const allTasks = await loadEvalDataset(options.datasetPath)
  const tasks = options.split ? allTasks.filter(task => task.split === options.split) : allTasks
  if (tasks.length === 0) throw new Error(`Evaluation dataset has no ${options.split ?? 'tasks'}.`)

  const runId = options.runId ?? randomUUID()
  const now = options.now ?? (() => new Date())
  const startedAtDate = now()
  const predictions: EvalPrediction[] = []
  for (const task of tasks) {
    const startedAt = performance.now()
    let result: EvalTaskRunResult
    try {
      result = normalizeResult(await options.runner(task, {
        runId,
        task,
        split: task.split,
        model: options.model,
        promptVersion: options.promptVersion,
      }))
    } catch (error) {
      result = normalizeResult({
        findings: [],
        failed: true,
        failureReason: error instanceof Error ? error.message : String(error),
      })
    }
    predictions.push({
      taskId: task.id,
      split: task.split,
      runId,
      model: options.model,
      promptVersion: options.promptVersion,
      findings: result.findings,
      patchTestPassed: result.patchTestPassed,
      repairAttempted: result.repairAttempted ?? task.repair.required,
      patchGenerated: result.patchGenerated,
      patchApplied: result.patchApplied,
      rollbackVerified: result.rollbackVerified,
      endToEndRepairSuccess: result.endToEndRepairSuccess,
      toolCalls: result.toolCalls,
      tokens: result.tokens,
      traceRunId: result.traceRunId,
      adaptiveEscalated: result.adaptiveEscalated,
      verifierInvoked: result.verifierInvoked,
      verifierCheckedFindingCount: result.verifierCheckedFindingCount,
      verifierRejectedFindingCount: result.verifierRejectedFindingCount,
      fallbackUsed: result.fallbackUsed,
      specialistCount: result.specialistCount,
      specialistFailureCount: result.specialistFailureCount,
      durationMs: Math.max(0, performance.now() - startedAt),
      failed: result.failed,
      failureReason: result.failureReason,
    })
  }
  const finishedAtDate = now()
  const manifest: EvalExperimentManifest = {
    runId,
    datasetPath: options.datasetPath,
    datasetVersion: tasks[0]!.datasetVersion,
    split: options.split ?? 'all',
    taskCount: tasks.length,
    mode: options.mode,
    model: options.model,
    promptVersion: options.promptVersion,
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
    failedTaskIds: predictions.filter(prediction => prediction.failed).map(prediction => prediction.taskId),
  }
  const report = await evaluateDataset({
    datasetPath: options.datasetPath,
    predictions,
    source: 'predictions',
    split: options.split,
  })
  await mkdir(options.outputDir, { recursive: true })
  await Promise.all([
    writeFile(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(path.join(options.outputDir, 'predictions.jsonl'), jsonl(predictions), 'utf8'),
    writeFile(path.join(options.outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  ])
  return { manifest, predictions, report, outputDir: options.outputDir }
}

export function formatExperimentSummary(result: EvalExperimentResult): string {
  return [
    `PRGuard evaluation run ${result.manifest.runId}`,
    `Mode: ${result.manifest.mode}  Model: ${result.manifest.model}  Prompt: ${result.manifest.promptVersion}`,
    `Dataset: ${result.manifest.datasetVersion} ${result.manifest.split}  Tasks: ${result.manifest.taskCount}`,
    `Failed tasks: ${result.manifest.failedTaskIds.length}`,
    `Finding F1: ${(result.report.metrics.findingF1 * 100).toFixed(1)}%  High-risk recall: ${result.report.metrics.highRiskRecall === null ? 'n/a' : `${(result.report.metrics.highRiskRecall * 100).toFixed(1)}%`}`,
    `Artifacts: ${result.outputDir}`,
  ].join('\n')
}

export type { EvalDifficulty }
