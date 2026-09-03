import { createHash, randomUUID } from 'node:crypto'

export function createId(prefix: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(prefix)) throw new Error(`Invalid ID prefix: ${prefix}`)
  return `${prefix}_${randomUUID()}`
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value))
}
