/**
 * "Add captions", end to end.
 *
 * Walks the sources chosen by `speechSources`, decodes each one, hands it to
 * Scribe, and maps every word back onto the timeline. The only interesting part
 * is the mapping, and it is worth stating plainly:
 *
 *   timeline time = clip.startTime + (word time in the file − clip.inPoint)
 *
 * Everything else here is sequencing and error handling. One source failing —
 * an undecodable file, a model that will not load — must not lose the words from
 * the others, so failures are collected and reported rather than thrown.
 *
 * A source only reaches that list once `transcribeStretch` has run out of goes
 * at it, so the failures here are the settled ones rather than every blip along
 * the way.
 */
import { getBlob } from './db'
import { dedupeOverlappingWords, wordsOntoTimeline, type TimedWord } from './captions'
import { decodeAudio } from './speechAudio'
import { transcribeStretch } from './scribe'
import { isAbort, RetriedError, toDisplayMessage } from './errors'
import type { SpeechSource } from './captionSources'
import type { Asset } from './types'

export interface TranscribeProgress {
  /** Sources finished so far. */
  done: number
  total: number
  /** What is being worked on right now. */
  label: string
  /** What the job is doing, where there is something to say. */
  detail?: string
  /** 0–1 within the current source, where it can be measured. */
  ratio?: number
  /**
   * Which go at the current source's chunk this is, past the first. Carried
   * through from `scribe.ts` untouched, because the thing worth telling the
   * user — that a slow moment is a wait and not a hang — is the same fact at
   * both ends of this function.
   */
  attempt?: number
}

export interface TimelineTranscript {
  /** Every word, in timeline order. */
  words: TimedWord[]
  /** Sources that produced nothing, with the reason. Shown, never swallowed. */
  failures: string[]
  /** Languages Scribe detected, so a mis-detection is visible in the UI. */
  languages: string[]
}

export interface TranscribeTimelineOptions {
  sources: readonly SpeechSource[]
  assets: readonly Asset[]
  onProgress?: (progress: TranscribeProgress) => void
  signal?: AbortSignal
}

/**
 * How one source's failure reads in the list the panel shows.
 *
 * The count is the whole addition, and it changes what the sentence is asking
 * for. "fal.ai is rate limiting you. Wait a moment and try again." on its own
 * invites another press straight away — which is the one thing that will not
 * work, because this already tried three times over several seconds and got the
 * same answer each time. Saying how many goes it had turns the same words into
 * a reason to wait properly, or to caption fewer clips at once.
 *
 * A failure with no count behind it is left exactly as it was: the ones that
 * never reach a retry at all — an undecodable file, media missing from the
 * library — are settled on the first look, and "tried 1 time" would be noise
 * pretending to be reassurance.
 */
function describeFailure(cause: unknown): string {
  const message = toDisplayMessage(cause)
  return cause instanceof RetriedError ? `${message} (tried ${cause.attempts} times)` : message
}

export async function transcribeTimeline({
  sources,
  assets,
  onProgress,
  signal,
}: TranscribeTimelineOptions): Promise<TimelineTranscript> {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const words: TimedWord[] = []
  const failures: string[] = []
  const languages = new Set<string>()

  let done = 0
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress?.({ done, total: sources.length, label: source.label })

    try {
      const asset = assetById.get(source.assetId)
      if (!asset) throw new Error('its media is no longer in the library')
      const blob = await getBlob(asset.blobKey)
      if (!blob) throw new Error('its media is no longer stored in this browser')

      // No language is sent: Scribe detects it per stretch, which is the right
      // answer for a timeline whose clips need not all be in one language.
      const result = await transcribeStretch({
        buffer: await decodeAudio(blob),
        from: source.inPoint,
        to: source.inPoint + source.duration,
        onProgress: (progress) =>
          onProgress?.({
            done,
            total: sources.length,
            label: source.label,
            ...(progress.message ? { detail: progress.message } : {}),
            ...(progress.ratio === undefined ? {} : { ratio: progress.ratio }),
            ...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
          }),
        ...(signal ? { signal } : {}),
      })

      if (result.languageCode) languages.add(result.languageCode)
      words.push(...wordsOntoTimeline(result.words, source))
    } catch (cause) {
      if (isAbort(cause)) throw cause
      failures.push(`${source.label}: ${describeFailure(cause)}`)
    } finally {
      done += 1
    }
  }

  onProgress?.({ done, total: sources.length, label: '' })

  return {
    // Sorted first, then thinned: layered takes cover the same seconds twice
    // over, and only one word can be the word being spoken.
    words: dedupeOverlappingWords(words.sort((a, b) => a.start - b.start)),
    failures,
    languages: [...languages],
  }
}
