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
import { whisperWords, type WhisperChunk, type WhisperGranularity } from '../lib/whisperWords'
import {
  describeAttempt,
  isMissingAlignment,
  labelAttempt,
  loadFailureMessage,
  verdictFor,
} from '../lib/speechModel'
import type { SpeechModelAttempt } from '../lib/models'
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
   * Ways to open the model, tried in order until one works. Downloading a model
   * and being able to run it are different things, and only this side finds out
   * which — see SPEECH_MODEL_ATTEMPTS.
   */
  attempts: readonly SpeechModelAttempt[]
  /** Whisper's own language name, e.g. "english". Absent means detect. */
  language?: string
}

/** What comes back. A `progress` stream, then exactly one end state. */
export type WhisperResponse =
  | { type: 'progress'; id: number; message: string; ratio?: number }
  | {
      type: 'done'
      id: number
      words: TimedWord[]
      /** Set only when it is not the model that was asked for. */
      usedModel?: string
      /** Set only when word timings were estimated rather than measured. */
      estimatedTiming?: boolean
    }
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
let loading: Promise<{ transcriber: Transcriber; usedModel: string }> | null = null
let loadedModel = ''

/**
 * Ways of opening a model already known not to work here, to why not.
 *
 * Remembered for the life of the worker so the ladder is walked once rather than
 * once per source — a project with six voice takes would otherwise fail the same
 * way six times over, and each failure costs a download and a session creation.
 * The reason is kept alongside, not just the fact, so the second source can be
 * told exactly what the first one found instead of "nothing was tried".
 */
const unusable = new Map<string, string>()

/**
 * Models that cannot time individual words, so we stop asking them to.
 *
 * Not a blacklist: such a model transcribes perfectly well and still emits the
 * timestamp tokens a phrase is bounded by, which is enough to caption from. This
 * only remembers which models need asking the other way, so the discovery — a
 * whole inference that ends in an exception — happens once per session rather
 * than once per voice take.
 */
const untimed = new Set<string>()

async function loadModel(
  request: WhisperRequest,
): Promise<{ transcriber: Transcriber; usedModel: string }> {
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
async function openPipeline(
  request: WhisperRequest,
): Promise<{ transcriber: Transcriber; usedModel: string }> {
  const module = await loadRuntime()
  const failures: string[] = []

  for (const attempt of request.attempts) {
    const model = attempt.model ?? request.model
    const label = labelAttempt(attempt)
    const key = `${model}|${label}`

    const condemned = unusable.get(key)
    if (condemned !== undefined) {
      failures.push(`${label} — ${condemned}`)
      continue
    }

    try {
      const transcriber = await module.pipeline('automatic-speech-recognition', model, {
        dtype: attempt.dtype,
        device: 'wasm',
        progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
          if (event.status !== 'progress') return
          post({
            type: 'progress',
            id: request.id,
            message: `downloading ${describeAttempt(attempt)}`,
            ratio: typeof event.progress === 'number' ? event.progress / 100 : undefined,
          })
        },
      })

      if (failures.length > 0) {
        // Worth saying out loud: a fallback can be slower, a bigger download,
        // and — when it is a different model — a different transcript.
        post({ type: 'progress', id: request.id, message: `using ${describeAttempt(attempt)}` })
      }
      return { transcriber, usedModel: model }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      failures.push(`${label} — ${detail}`)

      // A network failure is about today, not about this way of opening the
      // model, so it must not be blacklisted for the rest of the session.
      if (verdictFor(detail) === 'give-up') break
      unusable.set(key, detail)
    }
  }

  throw new Error(loadFailureMessage(request.model, failures))
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

  const { transcriber, usedModel } = await loadModel(request)
  post({ type: 'progress', id: request.id, message: 'listening' })

  // Word timings are measured against the audio and are what the highlight
  // deserves, but they need alignment heads in the model's generation config —
  // which is read at the first inference, not at load, so a model without them
  // gets all the way to here before saying so. That is recoverable rather than
  // fatal: the same model, asked instead for the timestamp tokens every Whisper
  // emits, bounds each phrase, and the words inside one can be spread across it.
  // Captions from a model that "cannot do timestamps" beat no captions.
  let granularity: WhisperGranularity = untimed.has(usedModel) ? 'segment' : 'word'
  let output: AsrOutput | AsrOutput[]
  try {
    output = await listen(transcriber, request, granularity)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (granularity === 'segment' || !isMissingAlignment(detail)) throw cause

    untimed.add(usedModel)
    granularity = 'segment'
    post({ type: 'progress', id: request.id, message: 'listening again for phrase timings' })
    output = await listen(transcriber, request, granularity)
  }

  const result = Array.isArray(output) ? output[0] : output
  post({
    type: 'done',
    id: request.id,
    words: whisperWords(result?.chunks ?? [], {
      duration: request.audio.length / request.sampleRate,
      granularity,
    }),
    // Named only when it is not the model that was asked for, since that is a
    // different transcript rather than merely a slower one.
    ...(usedModel === request.model ? {} : { usedModel }),
    ...(granularity === 'segment' ? { estimatedTiming: true } : {}),
  })
}

/** One pass over the audio, asking for timings at the granularity given. */
function listen(
  transcriber: Transcriber,
  request: WhisperRequest,
  granularity: WhisperGranularity,
): Promise<AsrOutput | AsrOutput[]> {
  return transcriber(request.audio, {
    // 'word' asks for timings measured against the audio and needs alignment
    // heads; `true` asks for the timestamp tokens that are part of every
    // Whisper's ordinary vocabulary, and bound a phrase rather than a word.
    return_timestamps: granularity === 'word' ? 'word' : true,
    chunk_length_s: CHUNK_SECONDS,
    stride_length_s: STRIDE_SECONDS,
    ...(request.language ? { language: request.language, task: 'transcribe' } : {}),
  })
}
