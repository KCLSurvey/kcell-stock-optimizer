import { runPipeline, type ProgressEvent } from '../lib/pipeline'
import type { ProcessingInput } from '../lib/types'

export interface WorkerRequest {
  type: 'process'
  payload: ProcessingInput
}

export type WorkerResponse =
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'success'; result: import('../lib/types').ProcessingResult; outputArrayBuffer: ArrayBuffer }
  | { type: 'error'; message: string }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type !== 'process') return
  try {
    const { result, outputArrayBuffer } = await runPipeline(e.data.payload, (event) => {
      const msg: WorkerResponse = { type: 'progress', event }
      self.postMessage(msg)
    })
    const msg: WorkerResponse = { type: 'success', result, outputArrayBuffer }
    self.postMessage(msg, { transfer: [outputArrayBuffer] })
  } catch (err) {
    const msg: WorkerResponse = { type: 'error', message: err instanceof Error ? err.message : String(err) }
    self.postMessage(msg)
  }
}
