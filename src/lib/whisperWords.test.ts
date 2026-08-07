import { describe, expect, it } from 'vitest'
import { splitSegments, whisperWords, type WhisperChunk } from './whisperWords'

const chunk = (text: string, start: number, end: number | null): WhisperChunk => ({
  text,
  timestamp: [start, end],
})

describe('whisperWords', () => {
  it('trims the leading space Whisper puts on every word', () => {
    const words = whisperWords([chunk(' Hello', 0, 0.4), chunk(' there', 0.4, 0.8)], {
      duration: 2,
    })
    expect(words.map((word) => word.text)).toEqual(['Hello', 'there'])
  })

  it('keeps punctuation, which is part of what was said and where a line ends', () => {
    const [only] = whisperWords([chunk(' country.', 0, 1)], { duration: 2 })
    expect(only?.text).toBe('country.')
  })

  it('gives an unterminated last word the rest of the audio', () => {
    // Whisper stops generating before closing the final word often enough that
    // dropping it would lose a word that was certainly spoken.
    const [only] = whisperWords([chunk(' trailing', 4, null)], { duration: 6 })
    expect(only).toEqual({ text: 'trailing', start: 4, end: 6 })
  })

  it('drops words timed past the end of the audio it was given', () => {
    const words = whisperWords([chunk(' real', 1, 1.4), chunk(' invented', 9, 9.5)], {
      duration: 3,
    })
    expect(words.map((word) => word.text)).toEqual(['real'])
  })

  it('clamps a word that runs off the end', () => {
    const [only] = whisperWords([chunk(' long', 2.5, 9)], { duration: 3 })
    expect(only?.end).toBe(3)
  })

  it('skips empty chunks rather than captioning a blank', () => {
    expect(
      whisperWords([chunk('  ', 0, 0.2), chunk(' word', 0.3, 0.6)], { duration: 1 }),
    ).toHaveLength(1)
  })

  it('throws away the subtitle boilerplate Whisper invents on silence', () => {
    const words = whisperWords(
      [chunk(' Thanks', 0, 0.5), chunk(' for', 0.5, 0.8), chunk(' watching!', 0.8, 1.4)],
      { duration: 2 },
    )
    expect(words).toEqual([])
  })

  it('keeps a real sentence that happens to contain one of those words', () => {
    const words = whisperWords(
      [
        chunk(' Remember', 0, 0.5),
        chunk(' to', 0.5, 0.7),
        chunk(' subscribe', 0.7, 1.2),
        chunk(' before', 1.2, 1.6),
        chunk(' the', 1.6, 1.8),
        chunk(' price', 1.8, 2.2),
        chunk(' goes', 2.2, 2.5),
        chunk(' up', 2.5, 2.8),
      ],
      { duration: 3 },
    )
    expect(words).toHaveLength(8)
  })

  it('collapses the stutter loop Whisper falls into on music', () => {
    const stuck = Array.from({ length: 20 }, (_, index) =>
      chunk(' la', index * 0.2, index * 0.2 + 0.15),
    )
    const words = whisperWords([...stuck, chunk(' end', 5, 5.4)], { duration: 6 })
    // A few kept, because someone may really say a word twice; the loop is not.
    expect(words.filter((word) => word.text === 'la').length).toBeLessThanOrEqual(3)
    expect(words.at(-1)?.text).toBe('end')
  })

  it('leaves ordinary repetition alone', () => {
    const words = whisperWords(
      [chunk(' very', 0, 0.3), chunk(' very', 0.3, 0.6), chunk(' good', 0.6, 1)],
      { duration: 2 },
    )
    expect(words.map((word) => word.text)).toEqual(['very', 'very', 'good'])
  })
})

/**
 * The path taken when a model has no alignment heads.
 *
 * Whisper still says which two seconds a phrase occupied — those timestamps are
 * ordinary tokens in its vocabulary — and says nothing about where inside it
 * each word fell. Splitting them is the one guess in the pipeline, so it is
 * worth pinning down what the guess promises: the phrase's own bounds are
 * exact, and everything inside them is in order and gapless.
 */
describe('splitSegments', () => {
  it('cuts a phrase into its words', () => {
    const words = splitSegments([chunk(' This is a mock', 0, 2)], 10)
    expect(words.map((word) => word.text)).toEqual(['This', 'is', 'a', 'mock'])
  })

  it('keeps the phrase bounds exactly, since those are the measured part', () => {
    const words = splitSegments([chunk(' one two three', 1.5, 3.25)], 10)
    expect(words[0]?.timestamp[0]).toBe(1.5)
    // Closed on the phrase's own end rather than on a running sum, so no sliver
    // is left or stolen at the seam.
    expect(words.at(-1)?.timestamp[1]).toBe(3.25)
  })

  it('leaves no gaps or overlaps between the words it invents', () => {
    const words = splitSegments([chunk(' an extraordinary claim indeed', 0, 4)], 10)
    for (const [index, word] of words.entries()) {
      if (index === 0) continue
      expect(word.timestamp[0]).toBeCloseTo(words[index - 1]!.timestamp[1] as number, 10)
    }
  })

  it('gives a long word more of the phrase than a short one', () => {
    // "an extraordinary" is not two equal halves of anything anyone says.
    const [short, long] = splitSegments([chunk(' an extraordinary', 0, 4)], 10)
    const shortSpan = (short!.timestamp[1] as number) - short!.timestamp[0]
    const longSpan = (long!.timestamp[1] as number) - long!.timestamp[0]
    expect(longSpan).toBeGreaterThan(shortSpan * 2)
  })

  it('gives a one-letter word a moment rather than a sliver', () => {
    // The trailing space counts toward the weight, so "a" is a fifth of "mock"
    // rather than a quarter — visible on screen rather than a flicker.
    const words = splitSegments([chunk(' a mock', 0, 1)], 10)
    const first = (words[0]!.timestamp[1] as number) - words[0]!.timestamp[0]
    expect(first).toBeGreaterThan(0.25)
  })

  it('gives an unclosed phrase the rest of the audio, as the word path does', () => {
    const words = splitSegments([chunk(' trailing off', 8, null)], 10)
    expect(words.at(-1)?.timestamp[1]).toBe(10)
  })

  it('drops a phrase with nothing in it', () => {
    expect(splitSegments([chunk('   ', 0, 1)], 10)).toEqual([])
  })

  it('runs the same cleanup over estimated words as over measured ones', () => {
    // Hallucinations arrive as a whole phrase on this path rather than word by
    // word, and are no more real for it.
    const words = whisperWords([chunk(' Thanks for watching!', 0, 3)], {
      duration: 4,
      granularity: 'segment',
    })
    expect(words).toEqual([])
  })

  it('still drops a phrase timed past the end of the audio', () => {
    const words = whisperWords([chunk(' said after the end', 9, 11)], {
      duration: 5,
      granularity: 'segment',
    })
    expect(words).toEqual([])
  })
})
