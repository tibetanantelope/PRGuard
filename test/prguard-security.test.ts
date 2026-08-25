import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'
import { createPrGuardServer } from '../src/prguard/http.js'
import type { RuntimeConfig } from '../src/config.js'

const runtime: RuntimeConfig = {
  model: 'test-model', baseUrl: 'http://localhost', mcpServers: {}, sourceSummary: 'test',
  prGuardApiKey: 'test-api-key', prGuardRateLimitPerMinute: 20,
}

async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port')
  return { port: address.port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

describe('PRGuard security controls', () => {
  it('protects internal endpoints while keeping health public', async () => {
    const server = createPrGuardServer({ runtime })
    const listener = await listen(server)
    try {
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/healthz`)).status, 200)
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs`)).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs`, { headers: { Authorization: 'Bearer test-api-key' } })).status, 200)
    } finally { await listener.close() }
  })
})
