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

/** One entry of a `return_timestamps: 'word'` result. */
export interface WhisperChunk {
  text: string
  /** Start and end in seconds. The end is null on an unterminated last word. */
  timestamp: [number, number | null] | [number, number]
}

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
  { duration }: WhisperWordsOptions,
): TimedWord[] {
  const words: TimedWord[] = []

  for (const chunk of chunks) {
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
