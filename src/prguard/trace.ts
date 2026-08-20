import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import type { AgentStep, ChatMessage, ModelAdapter, ModelRequestOptions } from '../types.js'
import type { ReviewInput } from './types.js'

export const PRGUARD_TRACE_DIR = path.join(MINI_CODE_DIR, 'prguard', 'runs')

export const traceEventTypes = [
  'run_started',
  'checkpoint',
  'model_request',
  'model_response',
  'tool_started',
  'tool_finished',
  'review_completed',
  'patch_generated',
  'approval',
  'patch_applied',
  'verification',
  'rollback',
  'run_finished',
  'run_failed',
] as const

export type TraceEventType = (typeof traceEventTypes)[number]

export type PrGuardTraceEvent = {
  runId: string
  sequence: number
  timestamp: string
  type: TraceEventType
  payload: Record<string, unknown>
}

export type PrGuardTraceSummary = {
  runId: string
  filePath: string
  cwd?: string
  status?: string
  eventCount: number
  startedAt?: string
  updatedAt?: string
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function traceFilePath(runId: string, baseDir = PRGUARD_TRACE_DIR): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`Invalid PRGuard run ID: ${runId}`)
  }
  return path.join(baseDir, `${runId}.jsonl`)
}

function publicReviewInput(input: ReviewInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    baseRef: input.baseRef,
    headRef: input.headRef,
    diffPath: input.diffPath,
    githubRef: input.githubRef,
    testCommand: input.testCommand,
    hasInlineDiff: Boolean(input.diffText),
  }
}

export class PrGuardTrace {
  private sequence = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(
    readonly runId: string,
    readonly filePath: string,
  ) {}

  record(type: TraceEventType, payload: Record<string, unknown> = {}): Promise<void> {
    const event: PrGuardTraceEvent = {
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      type,
      payload,
    }
    const line = `${safeJson(event)}\n`
    this.pending = this.pending.then(() => appendFile(this.filePath, line, 'utf8'))
    return this.pending
  }

  async flush(): Promise<void> {
    await this.pending
  }
}

export async function createPrGuardTrace(
  input: ReviewInput,
  options: { runId?: string; baseDir?: string; parentRunId?: string } = {},
): Promise<PrGuardTrace> {
  const runId = options.runId ?? randomUUID()
  const baseDir = options.baseDir ?? PRGUARD_TRACE_DIR
  await mkdir(baseDir, { recursive: true })
  const trace = new PrGuardTrace(runId, traceFilePath(runId, baseDir))
  await trace.record('run_started', {
    phase: 'review',
    input: publicReviewInput(input),
    parentRunId: options.parentRunId,
  })
  return trace
}

export async function loadPrGuardTrace(
  runId: string,
  baseDir = PRGUARD_TRACE_DIR,
): Promise<PrGuardTraceEvent[]> {
  const content = await readFile(traceFilePath(runId, baseDir), 'utf8')
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as PrGuardTraceEvent)
}

export async function listPrGuardTraces(
  baseDir = PRGUARD_TRACE_DIR,
): Promise<PrGuardTraceSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }

  const summaries: PrGuardTraceSummary[] = []
  for (const entry of entries.filter(name => name.endsWith('.jsonl'))) {
    const runId = entry.slice(0, -'.jsonl'.length)
    try {
      const events = await loadPrGuardTrace(runId, baseDir)
      const started = events.find(event => event.type === 'run_started')
      const finished = [...events].reverse().find(event =>
        event.type === 'run_finished' || event.type === 'run_failed',
      )
      summaries.push({
        runId,
        filePath: path.join(baseDir, entry),
        cwd: typeof started?.payload.input === 'object' && started.payload.input !== null
          ? String((started.payload.input as Record<string, unknown>).cwd ?? '') || undefined
          : undefined,
        status: finished?.type === 'run_failed'
          ? 'failed'
          : String(finished?.payload.status ?? (finished ? 'completed' : 'running')),
        eventCount: events.length,
        startedAt: started?.timestamp,
        updatedAt: events.at(-1)?.timestamp,
      })
    } catch {
      // Ignore incomplete or malformed trace files in the listing.
    }
  }
  return summaries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

export function replayPrGuardTrace(events: PrGuardTraceEvent[]): string {
  return events.map(event => {
    const time = event.timestamp.slice(11, 19)
    const details = Object.entries(event.payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : safeJson(value)}`)
      .join(' ')
    return `${String(event.sequence).padStart(3, '0')} ${time} ${event.type}${details ? ` ${details}` : ''}`
  }).join('\n')
}

export function withTraceModel(
  model: ModelAdapter,
  trace: PrGuardTrace,
): ModelAdapter {
  return {
    async next(messages: ChatMessage[], options?: ModelRequestOptions): Promise<AgentStep> {
      await trace.record('model_request', {
        messageCount: messages.length,
        toolCount: options?.tools?.length ?? 0,
        contentChars: messages.reduce((total, message) =>
          total + ('content' in message ? message.content.length : 0), 0),
      })
      try {
        const result = await model.next(messages, options)
        await trace.record('model_response', {
          type: result.type,
          contentChars: result.content?.length ?? 0,
          toolCallCount: result.type === 'tool_calls' ? result.calls.length : 0,
          stopReason: result.diagnostics?.stopReason,
        })
        return result
      } catch (error) {
        await trace.record('run_failed', {
          phase: 'model',
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }
}
