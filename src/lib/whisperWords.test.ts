import { describe, expect, it } from 'vitest'
import { whisperWords, type WhisperChunk } from './whisperWords'

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
