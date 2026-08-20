import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/types.js'
import { MINI_CODE_DIR } from '../src/config.js'
import {
  MAX_TOOL_RESULTS_PER_BATCH_CHARS,
  PERSISTED_OUTPUT_TAG,
  PREVIEW_SIZE_CHARS,
  TOOL_RESULTS_SUBDIR,
  applyToolResultBudget,
  createContentReplacementState,
  replaceLargeToolResult,
} from '../src/utils/tool-result-storage.js'

function toolResult(
  id: string,
  content: unknown,
): Omit<Extract<ChatMessage, { role: 'tool_result' }>, 'content'> & { content: unknown } {
  return {
    role: 'tool_result',
    toolUseId: id,
    toolName: 'run_command',
    content,
    isError: false,
  }
}

function extractSavedPath(content: string): string {
  const match = content.match(/Full output saved to: (.+)\n/)
  assert.ok(match, 'replacement should include saved path')
  return match[1]
}

function persistedMessages(
  results: Array<Extract<ChatMessage, { role: 'tool_result' }>>,
): Array<Extract<ChatMessage, { role: 'tool_result' }>> {
  return results.filter(result => result.content.startsWith(PERSISTED_OUTPUT_TAG))
}

describe('tool result replacement', () => {
  it('persists a single oversized tool result and preserves the full original output on disk', async () => {
    const state = createContentReplacementState()
    const original = 'x'.repeat(50_001)
    const result = await replaceLargeToolResult(
      toolResult('single-large', original),
      state,
    )

    assert.ok(result.content.startsWith(PERSISTED_OUTPUT_TAG))
    assert.ok(result.content.endsWith('</persisted-output>'))
    assert.ok(result.content.includes(original.slice(0, PREVIEW_SIZE_CHARS)))
    assert.equal(state.replacements.get('single-large'), result.content)

    const savedPath = extractSavedPath(result.content)
    const saved = await readFile(savedPath, 'utf8')
    assert.equal(saved, original)
  })

  it('honors the 50_000 single-result boundary', async () => {
    const exact = 'x'.repeat(50_000)
    const over = 'y'.repeat(50_001)

    const exactResult = await replaceLargeToolResult(toolResult('exact-single', exact))
    const overResult = await replaceLargeToolResult(toolResult('over-single', over))

    assert.equal(exactResult.content, exact)
    assert.ok(overResult.content.startsWith(PERSISTED_OUTPUT_TAG))
  })

  it('normalizes empty outputs without misclassifying non-empty falsy-looking strings', async () => {
    for (const [id, value] of [
      ['empty-string', ''],
      ['empty-whitespace', ' \n\t '],
      ['empty-null', null],
      ['empty-undefined', undefined],
    ] as const) {
      const result = await replaceLargeToolResult(toolResult(id, value))
      assert.equal(result.content, '(run_command completed with no output)')
    }

    for (const value of ['0', 'false', '[]']) {
      const result = await replaceLargeToolResult(toolResult(`non-empty-${value}`, value))
      assert.equal(result.content, value)
    }
  })

  it('honors the 200_000 batch boundary', async () => {
    const state = createContentReplacementState()
    const exact = await applyToolResultBudget([
      toolResult('batch-exact-a', 'a'.repeat(100_000)),
      toolResult('batch-exact-b', 'b'.repeat(100_000)),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[], state)

    assert.equal(exact.newlyReplaced.length, 0)
    assert.equal(persistedMessages(exact.results).length, 0)

    const overState = createContentReplacementState()
    const over = await applyToolResultBudget([
      toolResult('batch-over-a', 'a'.repeat(100_001)),
      toolResult('batch-over-b', 'b'.repeat(100_000)),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[], overState)

    assert.equal(over.newlyReplaced.length, 1)
    assert.equal(persistedMessages(over.results).length, 1)
  })

  it('replaces the largest fresh batch results until visible content is under budget', async () => {
    const state = createContentReplacementState()
    const result = await applyToolResultBudget([
      toolResult('largest-a', 'a'.repeat(100_000)),
      toolResult('largest-b', 'b'.repeat(100_000)),
      toolResult('largest-c', 'c'.repeat(100_000)),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[], state)

    const replacedIds = persistedMessages(result.results).map(message => message.toolUseId)
    const totalVisible = result.results.reduce(
      (sum, message) => sum + message.content.length,
      0,
    )

    assert.deepEqual(replacedIds, ['largest-a', 'largest-b'])
    assert.ok(totalVisible <= MAX_TOOL_RESULTS_PER_BATCH_CHARS)
    assert.equal(result.newlyReplaced.length, 2)
  })

  it('uses stable tie-breaking when same-size batch results need replacement', async () => {
    const state = createContentReplacementState()
    const result = await applyToolResultBudget([
      toolResult('tie-c', 'c'.repeat(100_000)),
      toolResult('tie-a', 'a'.repeat(100_000)),
      toolResult('tie-b', 'b'.repeat(100_000)),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[], state)

    const replacedIds = persistedMessages(result.results).map(message => message.toolUseId)
    assert.deepEqual(replacedIds.sort(), ['tie-a', 'tie-b'])
  })

  it('replays single-result replacements byte-identically without regenerating them', async () => {
    const state = createContentReplacementState()
    const original = 'x'.repeat(50_001)
    const first = await replaceLargeToolResult(
      toolResult('single-replay', original),
      state,
    )
    const second = await replaceLargeToolResult(
      toolResult('single-replay', original),
      state,
    )

    assert.equal(second.content, first.content)
    assert.equal(state.replacements.size, 1)
    assert.equal(state.replacements.get('single-replay'), first.content)
  })

  it('replays batch replacements byte-identically without new replacement records', async () => {
    const state = createContentReplacementState()
    const inputs = [
      toolResult('batch-replay-a', 'a'.repeat(100_001)),
      toolResult('batch-replay-b', 'b'.repeat(100_000)),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[]

    const first = await applyToolResultBudget(inputs, state)
    const replaced = persistedMessages(first.results)[0]
    assert.ok(replaced)

    const second = await applyToolResultBudget(inputs, state)
    const replayed = second.results.find(result => result.toolUseId === replaced.toolUseId)

    assert.equal(replayed?.content, replaced.content)
    assert.equal(second.newlyReplaced.length, 0)
  })

  it('does not re-persist content that is already a persisted-output replacement', async () => {
    const state = createContentReplacementState()
    const replacement = [
      PERSISTED_OUTPUT_TAG,
      'Output too large. Full output saved to: /tmp/example.txt',
      PERSISTED_OUTPUT_TAG,
    ].join('\n')

    const result = await applyToolResultBudget([
      toolResult('already-persisted', replacement),
      toolResult('fresh-small', 'ok'),
    ] as Extract<ChatMessage, { role: 'tool_result' }>[], state)

    assert.equal(result.results[0].content, replacement)
    assert.equal(state.replacements.get('already-persisted'), replacement)
    assert.equal(result.newlyReplaced.length, 0)
  })

  it('keeps persisted paths under the tool-results directory for unsafe toolUseIds', async () => {
    const original = 'z'.repeat(50_001)
    const result = await replaceLargeToolResult(
      toolResult('../..\\evil/name', original),
    )
    const savedPath = extractSavedPath(result.content)
    const root = path.join(MINI_CODE_DIR, TOOL_RESULTS_SUBDIR)
    const relative = path.relative(root, savedPath)

    assert.ok(!relative.startsWith('..'))
    assert.ok(!path.isAbsolute(relative))
    assert.equal(await readFile(savedPath, 'utf8'), original)
  })
})
