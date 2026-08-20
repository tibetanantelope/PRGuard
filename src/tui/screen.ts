import process from 'node:process'

const ENTER_ALT_SCREEN = '[?1049h'
const EXIT_ALT_SCREEN = '[?1049l'
const ERASE_SCREEN_AND_HOME = '[2J[H'
const HOME = '[H'
const ERASE_TO_END = '[J'
const ERASE_LINE = '[2K'
const ENABLE_MOUSE_TRACKING =
  '[?1000h' +
  '[?1002h' +
  '[?1006h'
const DISABLE_MOUSE_TRACKING =
  '[?1006l' +
  '[?1002l' +
  '[?1000l'

let previousFrameLines: string[] | null = null
let previousColumns = 0
let previousRows = 0

export function hideCursor(): void {
  process.stdout.write('[?25l')
}

export function showCursor(): void {
  process.stdout.write('[?25h')
}

export function enterAlternateScreen(): void {
  resetTerminalFrame()
  process.stdout.write(
    DISABLE_MOUSE_TRACKING + ENTER_ALT_SCREEN + ERASE_SCREEN_AND_HOME + ENABLE_MOUSE_TRACKING,
  )
}

export function exitAlternateScreen(): void {
  resetTerminalFrame()
  process.stdout.write(DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN)
}

export function clearScreen(): void {
  // Softer redraw than full clear to reduce visible flicker.
  process.stdout.write('[H[J')
}

export function resetTerminalFrame(): void {
  previousFrameLines = null
  previousColumns = 0
  previousRows = 0
}

export function renderTerminalFrame(frame: string): void {
  const lines = frame.split('\n')
  const columns = process.stdout.columns ?? 0
  const rows = process.stdout.rows ?? 0
  const forceFullRender =
    previousFrameLines === null ||
    previousColumns !== columns ||
    previousRows !== rows

  if (forceFullRender) {
    process.stdout.write(HOME + ERASE_TO_END + frame)
  } else {
    const previous = previousFrameLines ?? []
    const maxLines = Math.max(previous.length, lines.length)
    let output = ''

    for (let index = 0; index < maxLines; index += 1) {
      const nextLine = lines[index] ?? ''
      const previousLine = previous[index] ?? ''
      if (nextLine === previousLine) continue

      output += `[${index + 1};1H${ERASE_LINE}${nextLine}`
    }

    if (output.length > 0) {
      process.stdout.write(output)
    }
  }

  previousFrameLines = lines
  previousColumns = columns
  previousRows = rows
}
