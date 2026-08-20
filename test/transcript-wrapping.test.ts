import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSelectedText,
  getTranscriptMaxScrollOffset,
  renderTranscriptLines,
  type TranscriptEntry,
  type TranscriptSelection,
} from '../src/tui/transcript.ts'

function withTerminalWidth<T>(columns: number, fn: () => T): T {
  const original = process.stdout.columns
  Object.defineProperty(process.stdout, 'columns', {
    value: columns,
    configurable: true,
  })
  try {
    return fn()
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: original,
      configurable: true,
    })
  }
}

function makeWrappedAssistantEntry(): TranscriptEntry[] {
  const wrappedBody = `${'a'.repeat(166)}BCDEFG`
  return [
    {
      id: 1,
      kind: 'assistant',
      body: wrappedBody,
    },
  ]
}

describe('transcript wrapping', () => {
  it('uses a compact single-line separator between transcript entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 1, kind: 'user', body: 'first' },
      { id: 2, kind: 'assistant', body: 'second' },
    ]

    const lines = withTerminalWidth(60, () =>
      renderTranscriptLines(entries).map(line => line.replace(/\u001b\[[\d;]*[A-Za-z]/g, '')),
    )

    assert.equal(lines[0], 'you')
    assert.equal(lines[1]?.startsWith('> first'), true)
    assert.equal(lines[1]?.length, 56)
    assert.equal(lines[2], '·')
    assert.equal(lines[3], 'Minicode')
    assert.equal(lines[4], '  second')
  })

  it('renders user message body with gray background without styling the label', () => {
    const entries: TranscriptEntry[] = [
      { id: 1, kind: 'user', body: 'abcdef'.repeat(12) },
    ]

    const lines = withTerminalWidth(20, () => renderTranscriptLines(entries))

    assert.equal(lines[0].includes('\u001b[48;5;236m'), false)
    assert.equal(lines[1]?.startsWith('\u001b[48;5;236m'), true)
    assert.equal(lines[2]?.startsWith('\u001b[48;5;236m'), true)
    const firstBodyLine = lines[1]?.replace(/\u001b\[[\d;]*[A-Za-z]/g, '')
    assert.equal(firstBodyLine?.startsWith('> abcdef'), true)
    assert.equal(firstBodyLine?.length, 56)
    assert.equal(lines[1]?.endsWith('\u001b[0m'), true)
  })

  it('renders worked duration on final assistant entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 1, kind: 'assistant', body: 'done', workedForSeconds: 10 },
    ]

    const lines = withTerminalWidth(60, () =>
      renderTranscriptLines(entries).map(line => line.replace(/\u001b\[[\d;]*[A-Za-z]/g, '')),
    )

    assert.equal(lines[0], 'Minicode')
    assert.equal(lines[1], '  done')
    assert.equal(lines[2]?.endsWith('Worked for 10s'), true)
    assert.equal(lines[2]?.length, 56)
    assert.equal(lines[2]?.includes('-'), false)
  })

  it('counts wrapped visual rows when calculating scroll offset', () => {
    const entries = makeWrappedAssistantEntry()

    const offset = withTerminalWidth(60, () => getTranscriptMaxScrollOffset(entries, 4))

    assert.equal(offset, 1)
  })

  it('extracts text from a wrapped continuation row', () => {
    const entries = makeWrappedAssistantEntry()
    const selection: TranscriptSelection = {
      startLine: 4,
      startCol: 0,
      endLine: 4,
      endCol: 6,
    }

    const selected = withTerminalWidth(60, () => extractSelectedText(entries, selection))

    assert.equal(selected, 'BCDEFG')
  })
})
