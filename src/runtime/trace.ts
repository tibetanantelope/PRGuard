import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import { createId } from './ids.js'
import type { AgentPhase } from './types.js'

export type RuntimeTraceEvent = {
  runId: string
  sequence: number
  timestamp: string
  type: 'phase_changed' | 'memory_retrieved' | 'model_started' | 'model_finished' | 'tool_started' | 'tool_finished' | 'run_finished' | 'run_failed'
  payload: Record<string, unknown>
}

function tracePath(runId: string, baseDir: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid runtime trace run ID: ${runId}`)
  return path.join(baseDir, `${runId}.jsonl`)
}

export class RuntimeTrace {
  private sequence = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(readonly runId: string, readonly filePath: string) {}

  record(type: RuntimeTraceEvent['type'], payload: Record<string, unknown> = {}): Promise<void> {
    const event: RuntimeTraceEvent = {
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      type,
      payload,
    }
    this.pending = this.pending.then(() => appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8'))
    return this.pending
  }

  flush(): Promise<void> {
    return this.pending
  }
}

export async function createRuntimeTrace(runId = createId('run'), baseDir = path.join(MINI_CODE_DIR, 'runtime', 'traces')): Promise<RuntimeTrace> {
  await mkdir(baseDir, { recursive: true })
  const trace = new RuntimeTrace(runId, tracePath(runId, baseDir))
  await trace.record('phase_changed', { phase: 'input_loaded' satisfies AgentPhase })
  return trace
}

export async function loadRuntimeTrace(runId: string, baseDir = path.join(MINI_CODE_DIR, 'runtime', 'traces')): Promise<RuntimeTraceEvent[]> {
  const content = await readFile(tracePath(runId, baseDir), 'utf8')
  return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as RuntimeTraceEvent)
}

export async function listRuntimeTraces(baseDir = path.join(MINI_CODE_DIR, 'runtime', 'traces')): Promise<string[]> {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => entry.name.slice(0, -'.jsonl'.length))
}
