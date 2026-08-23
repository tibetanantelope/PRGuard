import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AnthropicModelAdapter } from '../anthropic-adapter.js'
import { runAgentTurn } from '../agent-loop.js'
import type { RuntimeConfig } from '../config.js'
import type { ModelAdapter } from '../types.js'
import { createDefaultToolRegistry } from '../tools/index.js'
import { withTraceModel, type PrGuardTrace } from './trace.js'
import { findingSchema, reviewResultSchema, type Finding, type PrDiffSnapshot, type ReviewResult } from './types.js'
import { buildPrReviewSystemPrompt, buildPrReviewUserPrompt } from './review-prompt.js'
import { applyDeterministicRules } from './rules.js'

const modelEvidenceSchema = z.object({
  source: z.enum(['diff', 'repository', 'code', 'dependency', 'configuration', 'test']),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  content: z.string().min(1),
  explanation: z.string().min(1),
})

const modelFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['security', 'reliability', 'code_quality']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  title: z.string().min(1),
  evidence: z.array(modelEvidenceSchema).min(1),
  reason: z.string().min(1),
  suggestedFix: z.string().min(1),
})

const modelReviewSchema = z.object({
  findings: z.array(modelFindingSchema),
})

const evidenceSourceNames = new Set([
  'diff',
  'repository',
  'code',
  'dependency',
  'configuration',
  'test',
])

export type ModelReviewOutput = z.infer<typeof modelReviewSchema>

function extractJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? content.trim()
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) {
      throw new Error('PRGuard model response did not contain a JSON object.')
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown
    } catch (error) {
      throw new Error(
        `PRGuard model response contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function normalizeModelReviewOutput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  const record = value as Record<string, unknown>
  const rawFindings = record.findings
  const findings = Array.isArray(rawFindings)
    ? rawFindings
    : rawFindings && typeof rawFindings === 'object'
      ? [rawFindings]
      : rawFindings
  if (!Array.isArray(findings)) {
    return value
  }
  return {
    ...record,
    findings: findings.map(finding => {
      if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
        return finding
      }
      const findingRecord = finding as Record<string, unknown>
      const evidence = findingRecord.evidence
      const normalizedEvidence = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
        ? [evidence]
        : evidence
      return {
        ...findingRecord,
        evidence: Array.isArray(normalizedEvidence)
          ? normalizedEvidence.map(item => {
              if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
              const evidenceRecord = item as Record<string, unknown>
              return {
                ...evidenceRecord,
                source: typeof evidenceRecord.source === 'string'
                  && evidenceSourceNames.has(evidenceRecord.source)
                  ? evidenceRecord.source
                  : 'repository',
              }
            })
          : normalizedEvidence,
      }
    }),
  }
}

export function parseModelReviewOutput(
  content: string,
  snapshot: PrDiffSnapshot,
): ReviewResult {
  const normalized = normalizeModelReviewOutput(extractJsonObject(content))
  if (typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>
    if (Array.isArray(record.findings)) {
      const changedPaths = new Set(snapshot.changedFiles.map(file => file.path))
      record.findings = record.findings.map(finding => {
        if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) return finding
        const findingRecord = finding as Record<string, unknown>
        if (!Array.isArray(findingRecord.evidence)) return finding
        return {
          ...findingRecord,
          evidence: findingRecord.evidence.map(evidence => {
            if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return evidence
            const evidenceRecord = evidence as Record<string, unknown>
            const isDiffEvidence = evidenceRecord.source === 'diff'
              && typeof evidenceRecord.file === 'string'
              && typeof evidenceRecord.content === 'string'
              && changedPaths.has(evidenceRecord.file)
              && snapshot.diffText.includes(evidenceRecord.content)
            return isDiffEvidence || evidenceRecord.source !== 'diff'
              ? evidenceRecord
              : { ...evidenceRecord, source: 'repository' }
          }),
        }
      })
    }
  }
  const parsed = modelReviewSchema.safeParse(normalized)
  if (!parsed.success) {
    throw new Error(`Invalid PRGuard review output: ${parsed.error.message}`)
  }

  const testCommand = snapshot.input.testCommand
  const findings: Finding[] = parsed.data.findings.map(finding => findingSchema.parse({
    ...finding,
    status: 'open',
    verification: {
      status: 'pending',
      commands: testCommand ? [testCommand] : [],
    },
  }))

  const bySeverity = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  }
  const byCategory = {
    security: 0,
    reliability: 0,
    code_quality: 0,
  }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1
    byCategory[finding.category] += 1
  }

  return reviewResultSchema.parse({
    schemaVersion: '0.1',
    reviewId: randomUUID(),
    createdAt: new Date().toISOString(),
    input: snapshot.input,
    findings,
    summary: {
      totalFindings: findings.length,
      bySeverity,
      byCategory,
    },
  })
}

export async function runPrReview(
  snapshot: PrDiffSnapshot,
  runtime: RuntimeConfig,
  options: {
    model?: ModelAdapter
    maxSteps?: number
    trace?: PrGuardTrace
    role?: string
    skillName?: string
    focus?: string
  } = {},
): Promise<ReviewResult> {
  const allTools = await createDefaultToolRegistry({
    cwd: snapshot.input.cwd,
    runtime,
  })
  const readOnlyTools = allTools.subset([
    'list_files',
    'grep_files',
    'read_file',
    'load_skill',
  ])
  const baseModel = options.model ?? new AnthropicModelAdapter(
    readOnlyTools,
    async () => runtime,
  )
  const model = options.trace ? withTraceModel(baseModel, options.trace) : baseModel
  const messages = await runAgentTurn({
    model,
    tools: readOnlyTools,
    cwd: snapshot.input.cwd,
    maxSteps: options.maxSteps ?? 12,
    modelName: runtime.model,
    onToolStart: (toolName, input) => {
      void options.trace?.record('tool_started', {
        toolName,
        inputKeys: typeof input === 'object' && input !== null ? Object.keys(input) : [],
      })
    },
    onToolResult: (toolName, output, isError) => {
      void options.trace?.record('tool_finished', {
        toolName,
        ok: !isError,
        outputChars: output.length,
      })
    },
    messages: [
      {
        role: 'system',
        content: buildPrReviewSystemPrompt({
          role: options.role,
          skillName: options.skillName,
          focus: options.focus,
        }),
      },
      { role: 'user', content: buildPrReviewUserPrompt(snapshot) },
    ],
  })
  const finalMessage = [...messages]
    .reverse()
    .find(message => message.role === 'assistant')
  if (!finalMessage || finalMessage.role !== 'assistant') {
    throw new Error('PRGuard review did not produce a final assistant response.')
  }
  let result: ReviewResult
  try {
    result = parseModelReviewOutput(finalMessage.content, snapshot)
  } catch (firstError) {
    await options.trace?.record('checkpoint', {
      phase: 'review_json_retry',
      reason: firstError instanceof Error ? firstError.message : String(firstError),
    })
    const retryTools = readOnlyTools.subset([])
    const retryMessages = await runAgentTurn({
      model,
      tools: retryTools,
      cwd: snapshot.input.cwd,
      maxSteps: 2,
      modelName: runtime.model,
      messages: [
        {
          role: 'system',
          content: [
            buildPrReviewSystemPrompt(),
            'The previous review response was not valid JSON.',
            'Do not call tools or add explanations.',
            'Convert the previous response into one valid JSON object with exactly this top-level shape: {"findings": [...]}.',
            'Every string value must be enclosed in double quotes. Return JSON only.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            buildPrReviewUserPrompt(snapshot),
            '',
            'Previous response to convert:',
            '```text',
            finalMessage.content,
            '```',
          ].join('\n'),
        },
      ],
    })
    const retryFinalMessage = [...retryMessages]
      .reverse()
      .find(message => message.role === 'assistant')
    if (!retryFinalMessage || retryFinalMessage.role !== 'assistant') {
      throw firstError
    }
    result = parseModelReviewOutput(retryFinalMessage.content, snapshot)
  }
  result = applyDeterministicRules(result, snapshot)
  await options.trace?.record('review_completed', {
    result,
    findingCount: result.findings.length,
    findingIds: result.findings.map(finding => finding.id),
    bySeverity: result.summary.bySeverity,
  })
  return result
}

export function formatReviewResult(result: ReviewResult): string {
  if (result.findings.length === 0) {
    return [
      'PRGuard review complete',
      'No evidence-backed risks found.',
    ].join('\n')
  }

  const lines = [
    `PRGuard review complete: ${result.summary.totalFindings} finding(s)`,
    `severity: low=${result.summary.bySeverity.low}, medium=${result.summary.bySeverity.medium}, high=${result.summary.bySeverity.high}, critical=${result.summary.bySeverity.critical}`,
    '',
  ]
  for (const finding of result.findings) {
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.id} ${finding.title}`,
      `  ${finding.category} ${finding.file}:${finding.lineStart}-${finding.lineEnd} confidence=${finding.confidence.toFixed(2)}`,
      `  reason: ${finding.reason}`,
      `  fix: ${finding.suggestedFix}`,
      `  evidence: ${finding.evidence.map(item => `${item.file}:${item.lineStart}-${item.lineEnd}`).join(', ')}`,
      '',
    )
  }
  return lines.join('\n')
}
