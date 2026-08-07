/**
 * Turning Whisper's output into words the caption model can use.
 *
 * Kept apart from the worker that produces it, and free of any import from
 * transformers.js, so the fiddly part can be tested without a 12MB runtime and
 * an 80MB model. And it is fiddly: the chunks come back with a leading space on
 * every word, punctuation attached, an open-ended timestamp on the last one, and
 * — for silence, music, or a held note — hallucinated repetitions that would put
 * text on screen for audio nobody spoke.
 */
import type { TimedWord } from './captions'

/** One entry of a `return_timestamps` result: a word, or a whole phrase. */
export interface WhisperChunk {
  text: string
  /** Start and end in seconds. The end is null on an unterminated last entry. */
  timestamp: [number, number | null] | [number, number]
}

/**
 * How finely the model was able to time what it heard.
 *
 * Two different mechanisms, not two settings. `word` is measured: Whisper's
 * cross-attention is aligned against the audio, which needs `alignment_heads` in
 * the model's generation config and is therefore not on offer everywhere.
 * `segment` is the timestamp tokens the model emits as part of its ordinary
 * vocabulary — every Whisper export has them, and they bound a phrase rather
 * than a word.
 */
export type WhisperGranularity = 'word' | 'segment'

/**
 * Whisper's stock hallucinations on silence.
 *
 * The model was trained on subtitled video, so given nothing to transcribe it
 * reaches for what subtitles say when nobody is speaking. These arrive with
 * confident timings and would otherwise become captions.
 */
const HALLUCINATIONS = [
  'thanks for watching',
  'thank you for watching',
  'subscribe',
  'subtitles by',
  'amara.org',
  'transcription by',
  'castingwords',
]

/**
 * How many times a word may repeat back to back before the run is treated as a
 * stutter loop rather than as speech.
 *
 * Whisper falls into these on music and long silence, emitting one word dozens
 * of times. Three is above anything said naturally and well below a loop.
 */
const MAX_REPEATS = 3

export interface WhisperWordsOptions {
  /** Seconds of audio submitted, so timings past the end can be dropped. */
  duration: number
  /** What the chunks are. Defaults to one word each. */
  granularity?: WhisperGranularity
}

/**
 * Converts chunks to timed words.
 *
 * The last chunk can carry a null end — Whisper stopped generating before it
 * closed the word — which is given the rest of the audio rather than being
 * dropped, since the word itself was certainly said.
 */
export function whisperWords(
  chunks: readonly WhisperChunk[],
  { duration, granularity = 'word' }: WhisperWordsOptions,
): TimedWord[] {
  const words: TimedWord[] = []
  const source = granularity === 'segment' ? splitSegments(chunks, duration) : chunks

  for (const chunk of source) {
    const text = chunk.text.trim()
    if (!text) continue

    const [start, rawEnd] = chunk.timestamp
    if (typeof start !== 'number' || !Number.isFinite(start)) continue
    // Whisper times against the audio it was given, so anything past the end of
    // that audio is invented rather than merely late.
    if (start >= duration) continue

    const end =
      typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? Math.min(rawEnd, duration) : duration

    words.push({ text, start: Math.max(0, start), end: Math.max(start, end) })
  }

  return dropStutters(dropHallucinations(words))
}

/**
 * Cuts a phrase into words and shares its span out between them.
 *
 * Exported for tests, and the one honest piece of guesswork in the pipeline: the
 * model has said "this phrase occupies these two seconds" and nothing about
 * where inside it each word fell. Long words are given proportionally more of
 * the span than short ones, which is closer to speech than an even split — "an
 * extraordinary claim" is not three equal thirds — and the trailing space is
 * counted so a one-letter word still gets a moment rather than a sliver.
 *
 * The result is a highlight that follows the line at about the right pace
 * instead of one measured against the audio. Every word stays individually
 * draggable, so a reading that lands wrong is a correction rather than a
 * dead end.
 */
export function splitSegments(chunks: readonly WhisperChunk[], duration: number): WhisperChunk[] {
  const out: WhisperChunk[] = []

  for (const chunk of chunks) {
    const words = chunk.text.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue

    const [start, rawEnd] = chunk.timestamp
    if (typeof start !== 'number' || !Number.isFinite(start)) continue

    // A null end means Whisper never closed the phrase; the rest of the audio is
    // the only defensible reading, and it is what the word path assumes too.
    const end =
      typeof rawEnd === 'number' && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : duration
    const span = Math.max(0, end - start)

    const weights = words.map((word) => word.length + 1)
    const total = weights.reduce((sum, weight) => sum + weight, 0)

    let at = start
    for (const [index, word] of words.entries()) {
      // The last word is closed on the phrase's own end rather than on an
      // accumulated sum, so rounding cannot leave or steal a sliver at the seam.
      const isLast = index === words.length - 1
      const next = isLast ? end : at + (span * weights[index]!) / total
      out.push({ text: word, timestamp: [at, next] })
      at = next
    }
  }

  return out
}

/** Removes the phrases Whisper reaches for when there is nothing to transcribe. */
function dropHallucinations(words: readonly TimedWord[]): TimedWord[] {
  if (words.length === 0) return []

  // Matched against the whole line rather than word by word: "subscribe" is a
  // real word, and it is only the stock phrase that is worth removing.
  const line = words
    .map((word) => word.text)
    .join(' ')
    .toLowerCase()
  const suspect = HALLUCINATIONS.find((phrase) => line.includes(phrase))
  if (!suspect) return [...words]

  // Only when it is essentially the whole of what came back. A real transcript
  // that happens to say "subscribe" keeps it.
  const share = suspect.length / Math.max(1, line.length)
  return share > 0.5 ? [] : [...words]
}

/** Collapses a word repeated more times than anyone says it. */
function dropStutters(words: readonly TimedWord[]): TimedWord[] {
  const kept: TimedWord[] = []
  let run = 0

  for (const word of words) {
    const previous = kept[kept.length - 1]
    const same = previous?.text.toLowerCase() === word.text.toLowerCase()
    run = same ? run + 1 : 0
    if (run >= MAX_REPEATS) continue
    kept.push(word)
  }

  return kept
}
