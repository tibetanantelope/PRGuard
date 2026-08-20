import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  WELCOME_CHEW_FRAMES,
  WELCOME_ESCAPE_FRAMES,
  advanceWelcomeAnimation,
  normalizeAsciiFrame,
  pushWelcomeAnimation,
  renderWelcomeBody,
  startWelcomeEscapeAnimation,
} from '../src/tty-app.ts'

function makeState() {
  return {
    transcript: [],
    nextEntryId: 1,
    transcriptScrollOffset: 0,
    welcomeAnimation: null,
  } as any
}

describe('welcome animation', () => {
  it('normalizes ASCII frame widths', () => {
    const normalized = normalizeAsciiFrame('a\nbbb')
    assert.deepEqual(normalized.split('\n'), ['a  ', 'bbb'])
  })

  it('keeps the chew animation face aligned across frames', () => {
    const faceColumns = WELCOME_CHEW_FRAMES.map(frame => {
      const faceLine = frame.split('\n')[1] ?? ''
      return faceLine.indexOf('(')
    })

    assert.deepEqual([...new Set(faceColumns)], [7])
  })

  it('ends the escape animation on a fully blank frame', () => {
    const finalFrame = WELCOME_ESCAPE_FRAMES[WELCOME_ESCAPE_FRAMES.length - 1]
    assert.equal(finalFrame?.replace(/\s/g, ''), '')
  })

  it('renders the welcome message with an ASCII frame', () => {
    const body = renderWelcomeBody('x')
    assert.equal(body, 'Welcome back!~\nx')
  })

  it('pushes a single assistant entry and advances the chew animation', () => {
    const state = makeState()

    pushWelcomeAnimation(state)
    const before = state.transcript[0].body
    const advanced = advanceWelcomeAnimation(state)

    assert.equal(state.transcript.length, 1)
    assert.equal(state.transcript[0].kind, 'assistant')
    assert.equal(advanced, true)
    assert.notEqual(state.transcript[0].body, before)
  })

  it('pauses animation while transcript is scrolled', () => {
    const state = makeState()
    pushWelcomeAnimation(state)
    const before = state.transcript[0].body
    state.transcriptScrollOffset = 1

    const advanced = advanceWelcomeAnimation(state)

    assert.equal(advanced, false)
    assert.equal(state.transcript[0].body, before)
  })

  it('plays escape animation once and freezes at the final frame', () => {
    const state = makeState()
    pushWelcomeAnimation(state)

    assert.equal(startWelcomeEscapeAnimation(state), true)
    const escapeStart = state.transcript[0].body
    for (let i = 0; i < 20; i++) {
      advanceWelcomeAnimation(state)
    }
    const frozen = state.transcript[0].body

    assert.notEqual(frozen, escapeStart)
    assert.equal(state.welcomeAnimation, null)
    assert.equal(advanceWelcomeAnimation(state), false)
    assert.equal(state.transcript[0].body, frozen)
    const finalFrameBody = renderWelcomeBody(WELCOME_ESCAPE_FRAMES.at(-1) ?? '')
      .split('\n')
      .slice(1)
      .join('\n')
    assert.equal(frozen.endsWith(finalFrameBody), true)
  })
})
