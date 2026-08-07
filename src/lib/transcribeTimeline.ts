/**
 * "Add captions", end to end.
 *
 * Walks the sources chosen by `speechSources`, decodes each one, sends it to be
 * transcribed a chunk at a time, and maps every word back onto the timeline.
 * The only interesting part is the mapping, and it is worth stating plainly:
 *
 *   timeline time = clip.startTime + (word time in the file − clip.inPoint)
 *
 * Everything else here is sequencing and error handling. One source failing —
 * an undecodable file, a chunk the provider rejects — must not lose the words
 * from the others, so failures are collected and reported rather than thrown.
 */
import { transcribe } from './elevenlabs'
import { getBlob } from './db'
import { dedupeOverlappingWords, wordsOntoTimeline, type TimedWord } from './captions'
import { chunkRanges, decodeAudio, speechChunkWav } from './speechAudio'
import { toDisplayMessage } from './errors'
import type { SpeechSource } from './captionSources'
import type { Asset } from './types'

export interface TranscribeProgress {
  /** Sources finished so far. */
  done: number
  total: number
  /** What is being worked on right now. */
  label: string
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
  key: string
  sources: readonly SpeechSource[]
  assets: readonly Asset[]
  /** Leave unset to let Scribe detect the language. */
  languageCode?: string
  onProgress?: (progress: TranscribeProgress) => void
  signal?: AbortSignal
}

export async function transcribeTimeline({
  key,
  sources,
  assets,
  languageCode,
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

      const buffer = await decodeAudio(blob)
      const fromFile: TimedWord[] = []

      for (const range of chunkRanges(source.inPoint, source.inPoint + source.duration)) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const chunk = await speechChunkWav(buffer, range)
        const result = await transcribe({
          key,
          audio: chunk,
          ...(languageCode ? { languageCode } : {}),
          ...(signal ? { signal } : {}),
        })
        if (result.languageCode) languages.add(result.languageCode)
        // Each chunk is timed from its own start, so put it back where it came
        // from before anything downstream sees it.
        for (const word of result.words) {
          fromFile.push({
            text: word.text,
            start: word.start + range.from,
            end: word.end + range.from,
          })
        }
      }

      words.push(...wordsOntoTimeline(fromFile, source))
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
      failures.push(`${source.label}: ${toDisplayMessage(cause)}`)
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
