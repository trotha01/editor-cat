/**
 * Transcription: ElevenLabs Scribe v2, run through fal.
 *
 * Scribe is here rather than behind some other provider for one reason: it
 * returns a timestamp per *word*, which is the whole requirement for karaoke
 * captions. A transcript with only sentence-level timings would have its word
 * timings guessed, and guessed word timings are exactly what a highlight moving
 * across the line makes obvious.
 *
 * Through fal rather than through ElevenLabs directly because that is where this
 * app's other model calls already go: the key belongs to the deployment and is
 * attached inside the proxy, so captions need no key from the user, cost them
 * nothing, and work on first load. The queue client in `falClient.ts` does the
 * submit-and-poll; everything specific to Scribe is in this file.
 *
 * What is sent is not the media file. The browser decodes each source and
 * re-encodes exactly the part a clip actually uses as mono 16kHz WAV — which is
 * also how the audio gets separated from a video, since a decoded MP4 is just
 * samples like anything else. See `speechAudio.ts`. It travels inside the
 * request as a data URI rather than being uploaded first, for reasons set out
 * where it happens.
 */
import { run } from './falClient'
import { chunkRanges, speechChunkWav } from './speechAudio'
import { isMockEnabled, mockTranscribe } from './mock'
import { SPEECH_TO_TEXT_MODEL } from './models'
import type { TimedWord } from './captions'

/**
 * One entry of Scribe's word list.
 *
 * `type` is the field that matters and the one it is easy to miss: the list
 * interleaves real words with the spacing between them, and — when audio events
 * are asked for — with things like `(laughter)`. Only `word` entries are words.
 * Taking the list as it comes would put a caption on screen for every gap
 * between two words.
 *
 * `speaker_id` is present when diarization is on. Captions have no use for it —
 * a karaoke line does not care who said it — which is why it is off, below.
 */
export interface ScribeWord {
  text: string
  start?: number
  end?: number
  type?: 'word' | 'spacing' | 'audio_event'
  speaker_id?: string
}

/**
 * What to ask Scribe for.
 *
 * Pure, and worth its own function because two of these are the model's own
 * defaults being turned *off*. `tag_audio_events` and `diarize` both default to
 * true at fal, and both produce something captions discard: audio events are
 * description rather than speech, and a speaker label has nowhere to go in a
 * karaoke line. Left at their defaults they would be work asked for, paid for
 * and thrown away.
 *
 * `keyterms` is deliberately absent rather than sent empty — it carries a 30%
 * premium, and biasing the model towards a list of words is a feature to add
 * knowingly, not to leave switched on by accident.
 */
export function scribeInput(audioUrl: string, languageCode?: string): Record<string, unknown> {
  return {
    audio_url: audioUrl,
    ...(languageCode ? { language_code: languageCode } : {}),
    tag_audio_events: false,
    diarize: false,
  }
}

export interface ScribeOutput {
  text?: string
  words?: ScribeWord[]
  /** ISO-639-3, e.g. "eng". */
  language_code?: string
  language_probability?: number
}

export interface ScribeResult {
  /** Words in spoken order, timed in seconds from the start of what was sent. */
  words: TimedWord[]
  /** What Scribe detected. Shown, so a mis-detection is visible rather than mysterious. */
  languageCode?: string
}

/**
 * Reads the words out of a Scribe response.
 *
 * Pure, and the only part of this file with any judgement in it, so it is where
 * the tests are. Words with no timing are dropped rather than defaulted to zero:
 * a word with no time cannot be highlighted at the right moment, and one
 * silently pinned to the start of the clip is worse than one that is missing.
 */
export function wordsFromScribe(output: ScribeOutput): TimedWord[] {
  return (output.words ?? [])
    .filter((word) => (word.type ?? 'word') === 'word')
    .filter(
      (word): word is ScribeWord & { start: number; end: number } =>
        typeof word.start === 'number' &&
        typeof word.end === 'number' &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end),
    )
    .map((word) => ({
      text: word.text.trim(),
      start: Math.max(0, word.start),
      // Scribe times a very short word as start === end. Left alone: the caption
      // model decides how long a word is lit for, and inventing a duration here
      // would be a second opinion in the wrong place.
      end: Math.max(word.start, word.end),
    }))
    .filter((word) => word.text.length > 0)
}

export interface TranscribeProgress {
  /** Where the job is, in words. Empty when there is nothing worth saying. */
  message: string
  /** 0–1 across the chunks of one source, where there is more than one. */
  ratio?: number
}

export interface TranscribeStretchOptions {
  /** The whole decoded source file. */
  buffer: AudioBuffer
  /** Seconds into the file to transcribe, being the part the clip actually uses. */
  from: number
  to: number
  /** ISO-639-3. Left unset, Scribe detects it. */
  languageCode?: string
  onProgress?: (progress: TranscribeProgress) => void
  signal?: AbortSignal
}

/**
 * Transcribes one stretch of one source, timed from the start of the file.
 *
 * Cut into chunks on the way out, because the audio travels inside the request
 * body as a data URI and the proxy in front of fal is a serverless function with
 * a payload ceiling — see `CHUNK_SECONDS`. The seams are the only reason this
 * chunks at all; Scribe itself has no such limit, and a take of any ordinary
 * length goes in one piece with no seams.
 */
export async function transcribeStretch({
  buffer,
  from,
  to,
  languageCode,
  onProgress,
  signal,
}: TranscribeStretchOptions): Promise<ScribeResult> {
  if (isMockEnabled()) {
    const mock = await mockTranscribe(Math.max(0, to - from))
    return {
      words: mock.words.map((word) => ({
        ...word,
        start: word.start + from,
        end: word.end + from,
      })),
      ...(mock.languageCode ? { languageCode: mock.languageCode } : {}),
    }
  }

  const ranges = chunkRanges(from, to)
  const words: TimedWord[] = []
  let detected: string | undefined

  for (const [index, range] of ranges.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const result = await transcribeChunk({
      audio: await speechChunkWav(buffer, range),
      ...(languageCode ? { languageCode } : {}),
      onProgress: (message) =>
        onProgress?.({
          message:
            ranges.length > 1 ? `part ${index + 1} of ${ranges.length} · ${message}` : message,
          ...(ranges.length > 1 ? { ratio: index / ranges.length } : {}),
        }),
      ...(signal ? { signal } : {}),
    })

    detected ??= result.languageCode
    // Each chunk is timed from its own start, so put it back on the source
    // file's own clock before anything downstream sees it.
    for (const word of result.words) {
      words.push({ text: word.text, start: word.start + range.from, end: word.end + range.from })
    }
  }

  return { words, ...(detected ? { languageCode: detected } : {}) }
}

interface ChunkOptions {
  audio: Blob
  languageCode?: string
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

async function transcribeChunk({
  audio,
  languageCode,
  onProgress,
  signal,
}: ChunkOptions): Promise<ScribeResult> {
  const output = await run<ScribeOutput>(
    SPEECH_TO_TEXT_MODEL,
    // A data URI rather than an uploaded file. fal offers both, and documents
    // the third option — `fal.storage.upload` — as the convenient one, but it
    // wants credentials in the browser, which is the whole thing this app's
    // proxy exists to avoid. It also leaves the audio at a publicly reachable
    // URL, and someone's voiceover is not ours to park somewhere public. A data
    // URI exists for the life of the request and nowhere else.
    //
    // fal notes that large files sent this way cost request performance, which
    // is the other half of why the chunks are sized the way they are.
    scribeInput(await toDataUrl(audio), languageCode),
    {
      ...(signal ? { signal } : {}),
      onProgress: (progress) =>
        onProgress?.(progress.status === 'IN_QUEUE' ? 'queued' : 'transcribing'),
    },
  )

  return {
    words: wordsFromScribe(output),
    ...(output.language_code ? { languageCode: output.language_code } : {}),
  }
}

/** Base64 via FileReader rather than by hand, which chunks megabytes without a stack of its own. */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('That audio could not be read for sending.'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}
