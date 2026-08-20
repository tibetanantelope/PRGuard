import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInputPrompt } from '../src/tui/input.ts'

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[\d;]*[A-Za-z]/g, '')
}

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

describe('renderInputPrompt', () => {
  it('renders empty input as one line with the first hint', () => {
    const rendered = withTerminalWidth(140, () => stripAnsi(renderInputPrompt('', 0)))

    assert.equal(rendered.includes('\n'), false)
    assert.equal(
      rendered,
      'mini-code prompt>   Ask for code, files, tasks, or MCP tools',
    )
  })

  it('cycles empty input hints by frame', () => {
    const rendered = withTerminalWidth(140, () => stripAnsi(renderInputPrompt('', 0, 1)))

    assert.equal(rendered.includes('\n'), false)
    assert.equal(
      rendered,
      'mini-code prompt>   Enter send; /help commands; Esc clear; Ctrl+C exit',
    )
  })

  it('hides the hint when input is present', () => {
    const rendered = stripAnsi(renderInputPrompt('hello', 5))

    assert.equal(rendered, 'mini-code prompt> hello ')
  })

  it('truncates hints to keep empty input on one line', () => {
    const rendered = withTerminalWidth(30, () => stripAnsi(renderInputPrompt('', 0)))

    assert.equal(rendered.includes('\n'), false)
    assert.equal(rendered, 'mini-code prompt>   Ask for code, files, tasks, or MC...')
  })
})
