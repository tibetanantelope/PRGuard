import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkingMemory, injectWorkingMemory, renderWorkingMemoryContext } from '../src/runtime/index.js'

test('working memory renders as stable structured context', () => {
  const memory = createWorkingMemory('Fix the failing test')
  const rendered = renderWorkingMemoryContext(memory)
  assert.match(rendered, /<working-memory>/)
  assert.match(rendered, /Goal: Fix the failing test/)
  assert.match(rendered, /Plan:/)
})

test('working memory is injected into a model projection without mutating history', () => {
  const messages = [{ role: 'user' as const, content: 'Continue' }]
  const memory = createWorkingMemory('Inspect the repository')
  const projected = injectWorkingMemory(messages, memory)
  assert.equal(messages.length, 1)
  assert.equal(projected.length, 2)
  assert.equal(projected[0]?.role, 'system')
  assert.match(projected[0]?.role === 'system' ? projected[0].content : '', /Goal: Inspect the repository/)
})
