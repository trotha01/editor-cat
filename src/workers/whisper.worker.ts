/**
 * Speech recognition, in this tab, on a worker thread.
 *
 * Whisper through transformers.js. It is here rather than on the main thread
 * because inference on a CPU is seconds to minutes of solid work, and a frozen
 * page cannot even offer the Cancel button — which matters more here than in
 * most places, since the first run also downloads a model.
 *
 * The runtime is fetched from our own origin at the moment it is first needed,
 * not bundled: see scripts/copy-speech-runtime.mjs for why. That is also why the
 * import below is a plain string the bundler is told to leave alone, and why the
 * shape of the module is declared here rather than imported — the types come
 * from a package that only exists at build time.
 *
 * The protocol is deliberately small — audio in, words out, progress in between
 * — and everything downstream of the model lives in whisperWords.ts, where it
 * can be tested without any of this.
 */
import { whisperWords, type WhisperChunk } from '../lib/whisperWords'
import type { TimedWord } from '../lib/captions'

/** What the main thread sends. */
export interface WhisperRequest {
  id: number
  /** Mono samples at `sampleRate`. Transferred, not copied. */
  audio: Float32Array
  sampleRate: number
  /** Hugging Face repo id. Passed in so Settings can override it. */
  model: string
  dtype: string
  /** Whisper's own language name, e.g. "english". Absent means detect. */
  language?: string
}

/** What comes back. A `progress` stream, then exactly one end state. */
export type WhisperResponse =
  | { type: 'progress'; id: number; message: string; ratio?: number }
  | { type: 'done'; id: number; words: TimedWord[] }
  | { type: 'error'; id: number; message: string }

/** Where the runtime and its WebAssembly are served from. */
const RUNTIME_URL = '/speech/transformers.js'
const WASM_PREFIX = '/speech/'

/**
 * Whisper works at 16kHz and nothing else. The caller resamples to it, so this
 * is an assertion rather than a conversion — silently accepting another rate
 * would produce a transcript timed against the wrong clock.
 */
const REQUIRED_SAMPLE_RATE = 16000

/**
 * How much audio the model sees at once, and how much neighbouring chunks
 * overlap. Whisper's own window is 30 seconds; the overlap is what stops a word
 * spoken across a boundary from being lost or doubled.
 */
const CHUNK_SECONDS = 30
const STRIDE_SECONDS = 5

/** The part of transformers.js this uses, declared rather than imported. */
interface AsrOutput {
  chunks?: WhisperChunk[]
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<AsrOutput | AsrOutput[]>

interface TransformersModule {
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Transcriber>
  env: {
    backends: { onnx: { wasm?: { numThreads?: number; wasmPaths?: string } } }
  }
}

let runtime: Promise<TransformersModule> | null = null

function loadRuntime(): Promise<TransformersModule> {
  runtime ??= import(/* @vite-ignore */ RUNTIME_URL).then((module: TransformersModule) => {
    const wasm = module.env.backends.onnx.wasm
    if (wasm) {
      // Same reasoning as the single-threaded ffmpeg core: threads need
      // SharedArrayBuffer, which needs COOP/COEP, which would block loading
      // provider media everywhere else in the app.
      wasm.numThreads = 1
      // A directory, not a filename. Which ONNX build to use is the library's
      // decision and it differs per browser; this only says where they live.
      wasm.wasmPaths = WASM_PREFIX
    }
    return module
  })
  return runtime
}

function post(message: WhisperResponse): void {
  self.postMessage(message)
}

/**
 * The loaded pipeline, kept between requests.
 *
 * Held as the promise rather than the result so that two sources arriving close
 * together wait on one load instead of starting two downloads.
 */
let loading: Promise<Transcriber> | null = null
let loadedKey = ''

async function loadModel(request: WhisperRequest): Promise<Transcriber> {
  const key = `${request.model}|${request.dtype}`
  // A model changed in Settings has to replace the one already loaded, or the
  // override would appear to do nothing until the tab was reloaded.
  if (loading && key !== loadedKey) loading = null
  if (loading) return loading

  loadedKey = key
  loading = loadRuntime()
    .then((module) =>
      module.pipeline('automatic-speech-recognition', request.model, {
        dtype: request.dtype,
        device: 'wasm',
        progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
          if (event.status !== 'progress') return
          post({
            type: 'progress',
            id: request.id,
            message: `downloading ${event.file ?? 'the speech model'}`,
            ratio: typeof event.progress === 'number' ? event.progress / 100 : undefined,
          })
        },
      }),
    )
    .catch((cause: unknown) => {
      // A failed load must not be left cached as a pending promise, or every
      // later attempt in this tab rejects with the same stale error.
      loading = null
      throw new Error(loadFailureMessage(request.model, cause))
    })

  return loading
}

/**
 * Says what was being attempted, because the underlying errors do not.
 *
 * "Failed to fetch" is what a browser reports for being offline, for a network
 * that blocks Hugging Face, and for a repo id that does not exist — three very
 * different problems, none of them mentioning the model. The other one worth
 * naming is a model without alignment heads, which is the difference between a
 * transcript and a karaoke caption and is otherwise a puzzle.
 */
function loadFailureMessage(model: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)

  if (/alignment_heads/i.test(detail)) {
    return (
      `"${model}" has no word-level timing in it, so there is nothing for the highlight to ` +
      `follow. Pick a model published with alignment heads — the "_timestamped" repos are ` +
      `built for this — in Settings.`
    )
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return (
      `The speech model "${model}" could not be downloaded. It comes from huggingface.co the ` +
      `first time you caption in the browser, so this needs a connection that can reach it. ` +
      `(${detail})`
    )
  }
  return `The speech model "${model}" could not be loaded. ${detail}`
}

self.addEventListener('message', (event: MessageEvent<WhisperRequest>) => {
  const request = event.data
  void run(request).catch((cause: unknown) => {
    post({
      type: 'error',
      id: request.id,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  })
})

async function run(request: WhisperRequest): Promise<void> {
  if (request.sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw new Error(
      `Speech recognition needs ${REQUIRED_SAMPLE_RATE}Hz audio, got ${request.sampleRate}Hz.`,
    )
  }

  const transcriber = await loadModel(request)
  post({ type: 'progress', id: request.id, message: 'listening' })

  const output = await transcriber(request.audio, {
    return_timestamps: 'word',
    chunk_length_s: CHUNK_SECONDS,
    stride_length_s: STRIDE_SECONDS,
    ...(request.language ? { language: request.language, task: 'transcribe' } : {}),
  })

  const result = Array.isArray(output) ? output[0] : output
  post({
    type: 'done',
    id: request.id,
    words: whisperWords(result?.chunks ?? [], {
      duration: request.audio.length / request.sampleRate,
    }),
  })
}
