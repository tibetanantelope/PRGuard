import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import type { PrGuardAction } from './security.js'
import { redactSensitiveValue } from './redaction.js'

export type PrGuardAuditEvent = {
  timestamp: string
  correlationId: string
  actor: string
  action: PrGuardAction
  decision: 'allowed' | 'denied'
  projectId?: string
  resource?: string
  metadata?: Record<string, unknown>
}

export class PrGuardAuditLog {
  constructor(private readonly filePath = path.join(MINI_CODE_DIR, 'prguard', 'audit.jsonl')) {}

  async record(event: PrGuardAuditEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(redactSensitiveValue(event))}\n`, 'utf8')
  }

  async list(): Promise<PrGuardAuditEvent[]> {
    try {
      return (await readFile(this.filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as PrGuardAuditEvent)
    } catch { return [] }
  }
}
