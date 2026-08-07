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
import { describeWeights, loadFailureMessage, verdictFor } from '../lib/speechModel'
import type { TimedWord } from '../lib/captions'

/** What the main thread sends. */
export interface WhisperRequest {
  id: number
  /** Mono samples at `sampleRate`. Transferred, not copied. */
  audio: Float32Array
  sampleRate: number
  /** Hugging Face repo id. Passed in so Settings can override it. */
  model: string
  /**
   * Weights to try, in order, until one will actually run. Downloading a model
   * and being able to run it are different things, and only this side knows
   * which — see SPEECH_MODEL_DTYPES.
   */
  dtypes: readonly string[]
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
let loadedModel = ''

/**
 * Weights already known not to run here: `model|dtype` to why not.
 *
 * Remembered for the life of the worker so the ladder is walked once rather than
 * once per source — a project with six voice takes would otherwise fail the same
 * way six times over, and each failure costs a download and a session creation.
 * The reason is kept alongside, not just the fact, so the second source can be
 * told exactly what the first one found instead of "nothing was tried".
 */
const unusable = new Map<string, string>()

async function loadModel(request: WhisperRequest): Promise<Transcriber> {
  // A model changed in Settings has to replace the one already loaded, or the
  // override would appear to do nothing until the tab was reloaded.
  if (loading && loadedModel !== request.model) loading = null
  if (loading) return loading

  loadedModel = request.model
  loading = openPipeline(request).catch((cause: unknown) => {
    // A failed load must not be left cached as a pending promise, or every
    // later attempt in this tab rejects with the same stale error.
    loading = null
    throw cause
  })

  return loading
}

/**
 * Opens the first set of weights that both downloads and runs.
 *
 * The failure this exists for is a model that arrives intact and is then refused
 * by the runtime — a quantised export whose operators this ONNX build will not
 * build a session for. Nothing before that point predicts it, so the answer is
 * to try the next set rather than to tell someone captions are unavailable.
 */
async function openPipeline(request: WhisperRequest): Promise<Transcriber> {
  const module = await loadRuntime()
  const attempts: string[] = []

  for (const dtype of request.dtypes) {
    const key = `${request.model}|${dtype}`
    const known = unusable.get(key)
    if (known !== undefined) {
      attempts.push(`${dtype} — ${known}`)
      continue
    }

    try {
      const transcriber = await module.pipeline('automatic-speech-recognition', request.model, {
        dtype,
        device: 'wasm',
        progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
          if (event.status !== 'progress') return
          post({
            type: 'progress',
            id: request.id,
            message: `downloading ${describeWeights(dtype)}`,
            ratio: typeof event.progress === 'number' ? event.progress / 100 : undefined,
          })
        },
      })

      if (attempts.length > 0) {
        // Worth saying out loud: a fallback is a bigger download and a slower
        // run, and silence would leave that looking like the model simply being
        // slow for no reason.
        post({ type: 'progress', id: request.id, message: `using ${describeWeights(dtype)}` })
      }
      return transcriber
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      attempts.push(`${dtype} — ${detail}`)
      // A network failure is about today, not about these weights, so it must
      // not blacklist them for the rest of the session.
      if (verdictFor(detail) === 'give-up') break
      unusable.set(key, detail)
    }
  }

  throw new Error(loadFailureMessage(request.model, attempts))
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
