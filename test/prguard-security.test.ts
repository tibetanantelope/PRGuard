import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPrGuardServer, startPrGuardServer } from '../src/prguard/http.js'
import type { RuntimeConfig } from '../src/config.js'

const runtime: RuntimeConfig = {
  model: 'test-model', baseUrl: 'http://localhost', mcpServers: {}, sourceSummary: 'test',
  prGuardApiKey: 'test-api-key', prGuardRateLimitPerMinute: 20, prGuardSandboxMode: 'local',
}

async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port')
  return { port: address.port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

describe('PRGuard security controls', () => {
  it('protects internal endpoints while keeping health public', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-security-'))
    const server = createPrGuardServer({ runtime, jobBaseDir: dir })
    const listener = await listen(server)
    try {
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/healthz`)).status, 200)
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs`)).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${listener.port}/api/v1/review-jobs`, { headers: { Authorization: 'Bearer test-api-key' } })).status, 200)
    } finally {
      await listener.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes readiness and refuses insecure non-loopback binding', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-readiness-'))
    const readinessRuntime = { ...runtime, prGuardApiKey: 'test-key' }
    const server = await startPrGuardServer({ runtime: readinessRuntime, host: '127.0.0.1', port: 0, jobBaseDir: dir })
    try {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const response = await fetch(`http://127.0.0.1:${port}/readyz`)
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { status: string }).status, 'ready')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
    assert.throws(
      () => createPrGuardServer({ runtime: { ...runtime, prGuardApiKey: undefined }, host: '0.0.0.0', port: 0 }),
      /outside loopback/,
    )
  })

  it('reports not ready when the required docker sandbox is unavailable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prguard-sandbox-readiness-'))
    const server = createPrGuardServer({
      runtime: { ...runtime, prGuardSandboxMode: 'docker' },
      jobBaseDir: dir,
      sandboxReadiness: async () => ({ ready: false, mode: 'docker', detail: 'daemon unavailable' }),
    })
    const listener = await listen(server)
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/readyz`)
      assert.equal(response.status, 503)
      assert.equal((await response.json() as { status: string }).status, 'not_ready')
    } finally {
      await listener.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
