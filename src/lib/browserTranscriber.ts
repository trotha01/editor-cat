/**
 * Driving the speech worker from the main thread.
 *
 * One worker for the whole session, so a project with six voice takes downloads
 * and loads the model once. Requests are numbered rather than queued by
 * identity, because a cancelled source's reply can still arrive after the next
 * one has started and must not be mistaken for it.
 *
 * The worker module is loaded lazily — `new Worker(new URL(…))` is what makes
 * Vite split transformers.js into a chunk of its own — so a visitor who never
 * captions in the browser never downloads any of it.
 */
import type { TimedWord } from './captions'
import type { WhisperRequest, WhisperResponse } from '../workers/whisper.worker'
import type { SpeechModelAttempt } from './models'

export interface BrowserTranscribeProgress {
  message: string
  /** 0–1 where known; absent while the model is thinking rather than loading. */
  ratio?: number
}

export interface BrowserTranscribeRequest {
  /** Mono samples at `sampleRate`. Consumed: the buffer is transferred away. */
  audio: Float32Array
  sampleRate: number
  model: string
  /** Ways to open the model, tried in order until one works. */
  attempts: readonly SpeechModelAttempt[]
  /** Whisper's own language name, e.g. "english". Absent means detect. */
  language?: string
  onProgress?: (progress: BrowserTranscribeProgress) => void
  signal?: AbortSignal
}

let worker: Worker | null = null
let nextId = 1

function ensureWorker(): Worker {
  worker ??= new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), {
    type: 'module',
  })
  return worker
}

/**
 * Transcribes one stretch of audio in this browser.
 *
 * Aborting resolves the caller but does not stop the worker: a wasm inference
 * cannot be interrupted, and terminating the worker would throw away a model
 * that took a minute to download. The reply for an abandoned request is dropped
 * when it arrives.
 */
export function transcribeInBrowser({
  audio,
  sampleRate,
  model,
  attempts,
  language,
  onProgress,
  signal,
}: BrowserTranscribeRequest): Promise<TimedWord[]> {
  const id = nextId++
  const instance = ensureWorker()

  return new Promise<TimedWord[]>((resolve, reject) => {
    const finish = (fn: () => void) => {
      instance.removeEventListener('message', onMessage)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onMessage = (event: MessageEvent<WhisperResponse>) => {
      const message = event.data
      if (message.id !== id) return
      if (message.type === 'progress') {
        onProgress?.({
          message: message.message,
          ...(message.ratio === undefined ? {} : { ratio: message.ratio }),
        })
        return
      }
      if (message.type === 'done') finish(() => resolve(message.words))
      else finish(() => reject(new Error(message.message)))
    }

    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))

    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    instance.addEventListener('message', onMessage)
    signal?.addEventListener('abort', onAbort, { once: true })

    const request: WhisperRequest = {
      id,
      audio,
      sampleRate,
      model,
      attempts,
      ...(language ? { language } : {}),
    }
    // Transferred rather than copied: a minute of 16kHz audio is a megabyte, and
    // the caller has no use for it afterwards.
    instance.postMessage(request, [audio.buffer as ArrayBuffer])
  })
}
