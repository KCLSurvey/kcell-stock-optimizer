import { createAbortState } from '../lib/cooperative'
import { serializeError, type SerializedError } from '../lib/errors'
import { runPipeline } from '../lib/pipeline'
import type { LogEntry, ProcessingInput, ProcessingResult, ProgressEvent } from '../lib/types'

export interface WorkerRequest {
  type: 'process'
  payload: ProcessingInput
}
export interface WorkerAbortRequest {
  type: 'abort'
}

export type WorkerResponse =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'log'; entry: Omit<LogEntry, 'id' | 'runId'> }
  | { type: 'success'; result: ProcessingResult; outputArrayBuffer: ArrayBuffer }
  | { type: 'error'; error: SerializedError }

const abortState = createAbortState()

self.onmessage = async (e: MessageEvent<WorkerRequest | WorkerAbortRequest>) => {
  if (e.data.type === 'abort') {
    abortState.aborted = true
    return
  }
  if (e.data.type !== 'process') return

  abortState.aborted = false
  try {
    const { result, outputArrayBuffer } = await runPipeline(
      e.data.payload,
      {
        onProgress: (event) => {
          const msg: WorkerResponse = { type: 'progress', event }
          self.postMessage(msg)
        },
        onLog: (entry) => {
          const msg: WorkerResponse = { type: 'log', entry }
          self.postMessage(msg)
        },
      },
      abortState,
    )
    const msg: WorkerResponse = { type: 'success', result, outputArrayBuffer }
    self.postMessage(msg, { transfer: [outputArrayBuffer] })
  } catch (err) {
    const error = serializeError(err)
    const msg: WorkerResponse = { type: 'error', error }
    self.postMessage(msg)
  }
}
