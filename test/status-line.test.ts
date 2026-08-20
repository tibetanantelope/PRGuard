import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderPermissionSummaryLine, renderStatusLine } from '../src/tui/chrome.ts'

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[\d;]*[A-Za-z]/g, '')
}

describe('renderStatusLine', () => {
  it('cycles Ready dots across animation frames', () => {
    assert.equal(stripAnsi(renderStatusLine(null, 0)), 'Ready.')
    assert.equal(stripAnsi(renderStatusLine(null, 1)), 'Ready..')
    assert.equal(stripAnsi(renderStatusLine(null, 2)), 'Ready...')
    assert.equal(stripAnsi(renderStatusLine(null, 3)), 'Ready.')
  })

  it('renders Thinking without dot animation', () => {
    assert.equal(stripAnsi(renderStatusLine('Thinking...', 0)), 'Thinking')
    assert.equal(stripAnsi(renderStatusLine('Thinking...', 1)), 'Thinking')
    assert.equal(stripAnsi(renderStatusLine('Thinking...', 2)), 'Thinking')
  })
})

describe('renderPermissionSummaryLine', () => {
  it('shows allowed categories separated by a pipe with overflow folded', () => {
    const summary = [
      'cwd: /repo',
      'extra allowed dirs: /one, /two',
      'dangerous allowlist: git push, npm publish',
      'trusted edit targets: /tmp/file',
    ]

    assert.equal(
      stripAnsi(renderPermissionSummaryLine(summary)),
      'extra allowed dirs: /one, ... | dangerous allowlist: git push, ...',
    )
  })

  it('renders none states for empty permission categories', () => {
    const summary = [
      'cwd: /repo',
      'extra allowed dirs: none',
      'dangerous allowlist: none',
    ]

    assert.equal(
      stripAnsi(renderPermissionSummaryLine(summary)),
      'extra allowed dirs: none | dangerous allowlist: none',
    )
  })
})
