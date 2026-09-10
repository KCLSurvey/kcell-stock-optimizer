import { ERROR_CODES, ProcessingError } from './errors'

/** Mutable flag flipped by the worker's 'abort' message handler; checked periodically by long loops. */
export interface AbortState {
  aborted: boolean
}

export function createAbortState(): AbortState {
  return { aborted: false }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Call inside long row loops every `everyN` iterations. Yields to the event loop
 * (so an in-flight 'abort' postMessage actually gets a chance to be delivered —
 * a worker cannot process new messages while a synchronous loop is running) and
 * throws E_ABORTED_BY_USER once the flag is set.
 */
export async function checkpoint(state: AbortState | undefined, i: number, everyN = 1000): Promise<void> {
  if (i % everyN !== 0) return
  await yieldToEventLoop()
  if (state?.aborted) {
    throw new ProcessingError(ERROR_CODES.ABORTED_BY_USER, 'Получена команда остановки — обработка прервана.')
  }
}
