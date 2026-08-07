/**
 * The two ways to turn audio into timed words.
 *
 * They differ in more than a network call, which is why they are an interface
 * rather than a flag. ElevenLabs is accurate, fast, needs a key and a payload
 * under a serverless ceiling — so it slices the audio up and posts it. The
 * in-browser model is free, private and needs no key at all, but downloads
 * eighty megabytes once and then thinks for a while — so it takes the audio
 * whole and reports progress instead.
 *
 * What they share is the currency: mono 16kHz samples in, words timed from the
 * start of the source file out. Both hear exactly the same audio, so switching
 * engines changes the transcript's accuracy and nothing about how it lands on
 * the timeline.
 */
import { transcribe } from './elevenlabs'
import { transcribeInBrowser } from './browserTranscriber'
import { chunkRanges, speechChunkWav, speechSamples, SPEECH_SAMPLE_RATE } from './speechAudio'
import { isMockEnabled, mockTranscribe } from './mock'
import type { TimedWord } from './captions'
import type { SpeechModelAttempt } from './models'

export type EngineId = 'elevenlabs' | 'browser'

export interface EngineProgress {
  message: string
  /** 0–1 where known. Absent where there is no total to measure against. */
  ratio?: number
}

export interface TranscribeSourceRequest {
  /** The whole decoded source file. */
  buffer: AudioBuffer
  /** Seconds into the file to transcribe, being the part the clip actually uses. */
  from: number
  to: number
  /** Absent means the engine should detect the language. */
  languageCode?: string
  onProgress?: (progress: EngineProgress) => void
  signal?: AbortSignal
}

export interface TranscriptionEngine {
  id: EngineId
  /** Words timed from the start of the source file, not from `from`. */
  transcribeSource(request: TranscribeSourceRequest): Promise<{
    words: TimedWord[]
    /** What the engine reckoned the language was, where it says. */
    languageCode?: string
  }>
}

/**
 * Which engine to start on.
 *
 * A key present means someone chose to pay for accuracy, so use it. With no
 * key the browser is not a fallback in the apologetic sense — it is the only
 * one that can run, and it can, which is the point of having it.
 */
export function defaultEngineId(hasElevenLabsKey: boolean): EngineId {
  return hasElevenLabsKey ? 'elevenlabs' : 'browser'
}

/**
 * ISO-639 codes to the language *names* Whisper expects.
 *
 * Two vocabularies for the same thing, and neither engine accepts the other's:
 * ElevenLabs wants "spa", Whisper wants "spanish". Mapping here keeps one list
 * of languages in the UI rather than one per engine.
 */
const WHISPER_LANGUAGE: Record<string, string> = {
  eng: 'english',
  spa: 'spanish',
  por: 'portuguese',
  fra: 'french',
  deu: 'german',
  ita: 'italian',
  hin: 'hindi',
  jpn: 'japanese',
  kor: 'korean',
  cmn: 'chinese',
}

export function whisperLanguageFor(code: string | undefined): string | undefined {
  return code ? WHISPER_LANGUAGE[code] : undefined
}

/** Words invented for mock mode, spread across the audio actually handed in. */
async function mockWords(request: TranscribeSourceRequest): Promise<TimedWord[]> {
  const { words } = await mockTranscribe(Math.max(0, request.to - request.from))
  return words.map((word) => ({
    text: word.text,
    start: word.start + request.from,
    end: word.end + request.from,
  }))
}

/**
 * ElevenLabs Scribe, through this site's proxy.
 *
 * Cut into chunks on the way out, because the proxy is a serverless function
 * with a payload ceiling — see speechAudio.ts. The seams are the only reason
 * this engine chunks at all; the model itself has no such limit.
 */
export function elevenLabsEngine(key: string): TranscriptionEngine {
  return {
    id: 'elevenlabs',
    async transcribeSource(request) {
      if (isMockEnabled()) return { words: await mockWords(request), languageCode: 'eng' }

      const ranges = chunkRanges(request.from, request.to)
      const words: TimedWord[] = []
      let languageCode: string | undefined

      for (const [index, range] of ranges.entries()) {
        if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        request.onProgress?.({
          message: ranges.length > 1 ? `Transcribing part ${index + 1} of ${ranges.length}` : '',
          ...(ranges.length > 1 ? { ratio: index / ranges.length } : {}),
        })

        const result = await transcribe({
          key,
          audio: await speechChunkWav(request.buffer, range),
          ...(request.languageCode ? { languageCode: request.languageCode } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        })
        languageCode ??= result.languageCode

        // Each chunk is timed from its own start, so put it back where it came
        // from before anything downstream sees it.
        for (const word of result.words) {
          words.push({
            text: word.text,
            start: word.start + range.from,
            end: word.end + range.from,
          })
        }
      }

      return { words, ...(languageCode ? { languageCode } : {}) }
    },
  }
}

export interface BrowserEngineOptions {
  /** Hugging Face repo id. From Settings, so a stale default is not a blocker. */
  model: string
  /** Ways to open the model, tried in order until one works. */
  attempts: readonly SpeechModelAttempt[]
}

/**
 * Whisper, downloaded once and run in this tab.
 *
 * No chunking here: the model has its own thirty-second window and overlaps its
 * chunks internally, which is better than anything this layer could do, and
 * there is no payload to stay under.
 */
export function browserEngine({ model, attempts }: BrowserEngineOptions): TranscriptionEngine {
  return {
    id: 'browser',
    async transcribeSource(request) {
      if (isMockEnabled()) return { words: await mockWords(request), languageCode: 'eng' }

      const audio = await speechSamples(request.buffer, { from: request.from, to: request.to })
      const words = await transcribeInBrowser({
        audio,
        sampleRate: SPEECH_SAMPLE_RATE,
        model,
        attempts,
        ...(whisperLanguageFor(request.languageCode)
          ? { language: whisperLanguageFor(request.languageCode) as string }
          : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })

      // Timed from the start of the stretch we handed over, so shift them back
      // onto the source file's own clock.
      return {
        words: words.map((word) => ({
          text: word.text,
          start: word.start + request.from,
          end: word.end + request.from,
        })),
      }
    },
  }
}
