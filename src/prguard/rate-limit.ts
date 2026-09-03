import { createClient } from 'redis'

export type PrGuardRateLimiter = { allow(key: string): Promise<boolean>; close(): Promise<void> }

export class InMemoryPrGuardRateLimiter implements PrGuardRateLimiter {
  private readonly clients = new Map<string, { startedAt: number; count: number }>()
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  async allow(key: string): Promise<boolean> {
    const now = Date.now()
    const current = this.clients.get(key)
    if (!current || now - current.startedAt >= this.windowMs) {
      this.clients.set(key, { startedAt: now, count: 1 }); return true
    }
    current.count += 1
    return current.count <= this.limit
  }
  async close(): Promise<void> {}
}

export class RedisPrGuardRateLimiter implements PrGuardRateLimiter {
  private readonly client: ReturnType<typeof createClient>
  private initialized?: Promise<void>
  constructor(private readonly url: string, private readonly limit: number, private readonly windowMs = 60_000) {
    this.client = createClient({ url })
  }
  async allow(key: string): Promise<boolean> {
    this.initialized ??= this.client.connect().then(() => undefined)
    await this.initialized
    const count = Number(await this.client.eval(
      `local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return count`,
      { keys: [`prguard:rate-limit:${key}`], arguments: [String(this.windowMs)] },
    ))
    return count <= this.limit
  }
  async close(): Promise<void> { if (this.client.isOpen) await this.client.quit() }
}

export function createPrGuardRateLimiter(limit: number, redisUrl?: string): PrGuardRateLimiter {
  return redisUrl ? new RedisPrGuardRateLimiter(redisUrl, limit) : new InMemoryPrGuardRateLimiter(limit)
}
