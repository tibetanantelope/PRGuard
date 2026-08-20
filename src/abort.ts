export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal)
  }
}

export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, Math.max(0, milliseconds))

    function finish(): void {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }

    function cancel(): void {
      clearTimeout(timer)
      reject(abortError(signal!))
    }

    signal?.addEventListener('abort', cancel, { once: true })
  })
}
