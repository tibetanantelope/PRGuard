import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import { createId } from './ids.js'
import type { RuntimeState, WorkingMemory } from './types.js'
import type { ChatMessage } from '../types.js'
import { RUNTIME_SCHEMA_VERSION } from './types.js'

export type WorkingMemoryRecord = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  runId: string
  revision: number
  memory: WorkingMemory
  savedAt: string
}

export type Checkpoint = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION
  checkpointId: string
  runId: string
  taskId: string
  version: number
  phase: RuntimeState['run']['phase']
  state: RuntimeState
  messagesRef?: string
  messagesSnapshot?: ChatMessage[]
  artifactRefs: string[]
  outputs?: Record<string, unknown>
  inputHash?: string
  idempotencyKey: string
  committedAt: string
}

export type CheckpointStoreOptions = {
  baseDir?: string
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
}

function runDir(baseDir: string, runId: string): string {
  assertSafeId(runId, 'run ID')
  return path.join(baseDir, runId)
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${createId('tmp')}.partial`
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryPath, filePath)
}

function parseRecord<T>(content: string, filePath: string): T {
  try {
    return JSON.parse(content) as T
  } catch (error) {
    throw new Error(`Invalid runtime state file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isMemoryRecord(value: unknown): value is WorkingMemoryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<WorkingMemoryRecord>
  return record.schemaVersion === RUNTIME_SCHEMA_VERSION
    && typeof record.runId === 'string'
    && typeof record.revision === 'number'
    && Number.isInteger(record.revision)
    && record.revision >= 0
    && typeof record.memory === 'object'
    && record.memory !== null
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== 'object' || value === null) return false
  const checkpoint = value as Partial<Checkpoint>
  return checkpoint.schemaVersion === RUNTIME_SCHEMA_VERSION
    && typeof checkpoint.checkpointId === 'string'
    && typeof checkpoint.runId === 'string'
    && typeof checkpoint.taskId === 'string'
    && typeof checkpoint.version === 'number'
    && Number.isInteger(checkpoint.version)
    && checkpoint.version > 0
    && typeof checkpoint.state === 'object'
    && checkpoint.state !== null
    && Array.isArray(checkpoint.artifactRefs)
    && typeof checkpoint.idempotencyKey === 'string'
    && typeof checkpoint.committedAt === 'string'
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(dir, entry.name))
  } catch {
    return []
  }
}

export class WorkingMemoryStore {
  private readonly baseDir: string

  constructor(options: CheckpointStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(MINI_CODE_DIR, 'runtime', 'working-memory')
  }

  async save(runId: string, memory: WorkingMemory, revision?: number): Promise<WorkingMemoryRecord> {
    const current = await this.load(runId)
    const nextRevision = revision ?? (current?.revision ?? 0) + 1
    if (!Number.isInteger(nextRevision) || nextRevision < 1) {
      throw new Error(`Working memory revision must be a positive integer: ${nextRevision}`)
    }
    const record: WorkingMemoryRecord = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      runId,
      revision: nextRevision,
      memory,
      savedAt: new Date().toISOString(),
    }
    const filePath = path.join(runDir(this.baseDir, runId), `revision-${String(nextRevision).padStart(12, '0')}-${createId('memory')}.json`)
    await writeAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  async load(runId: string): Promise<WorkingMemoryRecord | null> {
    const records: WorkingMemoryRecord[] = []
    for (const filePath of await listJsonFiles(runDir(this.baseDir, runId))) {
      try {
        const value = parseRecord<unknown>(await readFile(filePath, 'utf8'), filePath)
        if (isMemoryRecord(value) && value.runId === runId) records.push(value)
      } catch {
        // Ignore incomplete or corrupted records and use the latest valid revision.
      }
    }
    records.sort((left, right) => right.revision - left.revision || right.savedAt.localeCompare(left.savedAt))
    return records[0] ?? null
  }
}

export class CheckpointStore {
  private readonly baseDir: string

  constructor(options: CheckpointStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(MINI_CODE_DIR, 'runtime', 'checkpoints')
  }

  async save(checkpoint: Checkpoint): Promise<Checkpoint> {
    assertSafeId(checkpoint.runId, 'run ID')
    assertSafeId(checkpoint.checkpointId, 'checkpoint ID')
    const filePath = path.join(runDir(this.baseDir, checkpoint.runId), `checkpoint-${String(checkpoint.version).padStart(12, '0')}-${checkpoint.checkpointId}.json`)
    await writeAtomic(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`)
    return checkpoint
  }

  async list(runId: string): Promise<Checkpoint[]> {
    const checkpoints: Checkpoint[] = []
    for (const filePath of await listJsonFiles(runDir(this.baseDir, runId))) {
      try {
        const value = parseRecord<unknown>(await readFile(filePath, 'utf8'), filePath)
        if (isCheckpoint(value) && value.runId === runId) checkpoints.push(value)
      } catch {
        // Ignore partial/corrupt files so a single failed write cannot block recovery.
      }
    }
    return checkpoints.sort((left, right) => right.version - left.version || right.committedAt.localeCompare(left.committedAt))
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return (await this.list(runId))[0] ?? null
  }

  async findByIdempotencyKey(runId: string, idempotencyKey: string): Promise<Checkpoint | null> {
    return (await this.list(runId)).find(item => item.idempotencyKey === idempotencyKey) ?? null
  }

  async listByMessagesRef(messagesRef: string): Promise<Checkpoint[]> {
    const runs = await readdir(this.baseDir, { withFileTypes: true }).catch(() => [])
    const checkpoints: Checkpoint[] = []
    for (const run of runs.filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))) {
      checkpoints.push(...(await this.list(run.name)).filter(checkpoint => checkpoint.messagesRef === messagesRef))
    }
    return checkpoints.sort((left, right) => right.committedAt.localeCompare(left.committedAt) || right.version - left.version)
  }
}

export class CheckpointManager {
  constructor(
    private readonly checkpoints: CheckpointStore = new CheckpointStore(),
    private readonly workingMemory: WorkingMemoryStore = new WorkingMemoryStore(),
  ) {}

  async commit(args: {
    state: RuntimeState
    messagesRef?: string
    messagesSnapshot?: ChatMessage[]
    artifactRefs?: string[]
    outputs?: Record<string, unknown>
    inputHash?: string
    idempotencyKey?: string
    now?: string
  }): Promise<Checkpoint> {
    const idempotencyKey = args.idempotencyKey ?? `${args.state.run.runId}:${args.state.run.phase}`
    const existing = await this.checkpoints.findByIdempotencyKey(args.state.run.runId, idempotencyKey)
    if (existing) return existing

    const latest = await this.checkpoints.latest(args.state.run.runId)
    const checkpoint: Checkpoint = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      checkpointId: createId('checkpoint'),
      runId: args.state.run.runId,
      taskId: args.state.run.taskId,
      version: (latest?.version ?? 0) + 1,
      phase: args.state.run.phase,
      state: args.state,
      messagesRef: args.messagesRef,
      messagesSnapshot: args.messagesSnapshot ? structuredClone(args.messagesSnapshot) : undefined,
      artifactRefs: [...(args.artifactRefs ?? args.state.workingMemory.artifactRefs)],
      outputs: args.outputs ? structuredClone(args.outputs) : undefined,
      inputHash: args.inputHash,
      idempotencyKey,
      committedAt: args.now ?? new Date().toISOString(),
    }
    await this.workingMemory.save(args.state.run.runId, args.state.workingMemory)
    return this.checkpoints.save(checkpoint)
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return this.checkpoints.latest(runId)
  }

  async recover(runId: string, expectedInputHash?: string): Promise<RuntimeState | null> {
    const checkpoint = await this.latest(runId)
    if (!checkpoint) return null
    if (expectedInputHash !== undefined && checkpoint.inputHash !== expectedInputHash) {
      throw new Error(`Checkpoint input hash mismatch for run ${runId}.`)
    }
    return checkpoint.state
  }

  async latestForMessagesRef(messagesRef: string): Promise<Checkpoint | null> {
    return (await this.checkpoints.listByMessagesRef(messagesRef))[0] ?? null
  }

  async latestResumableForMessagesRef(messagesRef: string): Promise<Checkpoint | null> {
    return (await this.checkpoints.listByMessagesRef(messagesRef))
      .find(checkpoint => checkpoint.state.run.status !== 'completed') ?? null
  }
}
