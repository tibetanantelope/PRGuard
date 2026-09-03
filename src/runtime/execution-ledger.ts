import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import type { ToolResult, ToolRisk } from '../tool.js'
import { hashJson } from './ids.js'

export type ToolExecutionRecord = {
  runId: string
  idempotencyKey: string
  callId: string
  toolName: string
  inputHash: string
  risk: ToolRisk
  status: 'started' | 'completed' | 'failed' | 'indeterminate'
  result?: ToolResult
  error?: string
  recordedAt: string
}

export class ToolExecutionLedger {
  constructor(private readonly baseDir = path.join(MINI_CODE_DIR, 'runtime', 'tool-executions')) {}

  private filePath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid runtime run ID: ${runId}`)
    return path.join(this.baseDir, `${runId}.jsonl`)
  }

  async latest(runId: string, idempotencyKey: string): Promise<ToolExecutionRecord | null> {
    let content: string
    try { content = await readFile(this.filePath(runId), 'utf8') } catch { return null }
    let latest: ToolExecutionRecord | null = null
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as ToolExecutionRecord
        if (record.runId === runId && record.idempotencyKey === idempotencyKey) latest = record
      } catch { /* Ignore an incomplete final append. */ }
    }
    return latest
  }

  async start(args: Omit<ToolExecutionRecord, 'inputHash' | 'status' | 'recordedAt'> & { input: unknown }): Promise<ToolExecutionRecord> {
    const existing = await this.latest(args.runId, args.idempotencyKey)
    if (existing) return existing
    return this.append({ ...args, inputHash: hashJson(args.input), status: 'started', recordedAt: new Date().toISOString() })
  }

  complete(started: ToolExecutionRecord, result: ToolResult): Promise<ToolExecutionRecord> {
    return this.append({ ...started, status: 'completed', result, error: undefined, recordedAt: new Date().toISOString() })
  }

  fail(started: ToolExecutionRecord, error: string, indeterminate = false): Promise<ToolExecutionRecord> {
    return this.append({ ...started, status: indeterminate ? 'indeterminate' : 'failed', error, recordedAt: new Date().toISOString() })
  }

  private async append(record: ToolExecutionRecord & { input?: unknown }): Promise<ToolExecutionRecord> {
    const { input: _input, ...persisted } = record
    await mkdir(this.baseDir, { recursive: true })
    await appendFile(this.filePath(record.runId), `${JSON.stringify(persisted)}\n`, 'utf8')
    return persisted
  }
}
