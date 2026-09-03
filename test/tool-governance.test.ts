import assert from 'node:assert/strict'
import { z } from 'zod'
import test from 'node:test'
import { ToolRegistry } from '../src/tool.js'

test('tool governance exposes risk metadata and truncates oversized output', async () => {
  const registry = new ToolRegistry([
    {
      name: 'read_demo', description: 'demo', inputSchema: {}, schema: z.object({}),
      async run() { return { ok: true, output: '123456789' } },
    },
  ], {}, undefined, { maxOutputChars: 4 })
  assert.deepEqual(registry.manifest(), [{ name: 'read_demo', risk: 'read_only', timeoutMs: undefined }])
  const result = await registry.execute('read_demo', {}, { cwd: 'D:/workspace' })
  assert.equal(result.output, '1234\n[tool output truncated by policy]')
})

test('tool governance aborts a tool that exceeds its deadline', async () => {
  const registry = new ToolRegistry([
    {
      name: 'slow_demo', description: 'demo', inputSchema: {}, schema: z.object({}), timeoutMs: 10,
      async run(_input, context) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100)
          context.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
        })
        return { ok: true, output: 'done' }
      },
    },
  ])
  const result = await registry.execute('slow_demo', {}, { cwd: 'D:/workspace' })
  assert.equal(result.ok, false)
  assert.match(result.output, /timed out/i)
})
