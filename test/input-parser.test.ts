import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SLASH_COMMANDS, findMatchingSlashCommands } from '../src/cli-commands.js'
import { parseInputChunk } from '../src/tui/input-parser.js'

describe('parseInputChunk multiline paste', () => {
  it('does not emit submit keys for pasted newlines and preserves the full text', () => {
    const pasted = 'test1\r\ntest2\r\ntest3\r\ntest4\r\ntest5'
    const result = parseInputChunk('', pasted)

    assert.equal(result.rest, '')
    assert.equal(
      result.events.some(
        event => event.kind === 'key' && event.name === 'return',
      ),
      false,
    )
    assert.equal(
      result.events
        .filter((event): event is Extract<(typeof result.events)[number], { kind: 'text' }> =>
          event.kind === 'text',
        )
        .map(event => event.text)
        .join(''),
      'test1\ntest2\ntest3\ntest4\ntest5',
    )
  })
})

describe('slash commands', () => {
  it('registers /collapse', () => {
    assert.ok(SLASH_COMMANDS.some(command => command.usage === '/collapse'))
    assert.ok(findMatchingSlashCommands('/coll').includes('/collapse'))
  })
})
