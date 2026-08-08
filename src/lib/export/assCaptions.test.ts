import { describe, expect, it } from 'vitest'
import { assColor, assTime, buildAssFile, escapeAssText } from './assCaptions'
import { defaultCaptionStyle } from '../captions'
import type { CaptionCue, CaptionTrack } from '../types'

const style = defaultCaptionStyle()

const track = (id = 'track-1', overrides: Partial<CaptionTrack> = {}): CaptionTrack => ({
  id,
  name: id,
  hidden: false,
  style,
  ...overrides,
})

const cue = (
  id: string,
  start: number,
  end: number,
  words: [string, number, number][],
  trackId = 'track-1',
): CaptionCue => ({
  id,
  trackId,
  start,
  end,
  words: words.map(([text, wordStart, wordEnd]) => ({
    id: `${id}-${text}`,
    text,
    start: wordStart,
    end: wordEnd,
  })),
})

const base = { width: 720, height: 1280 }

/** Every Dialogue line in the file, in order. */
function events(file: string): string[] {
  return file.split('\n').filter((line) => line.startsWith('Dialogue:'))
}

/** The text field of a Dialogue line, which is everything after the ninth comma. */
function textOf(line: string): string {
  return line.split(',').slice(9).join(',')
}

describe('assColor', () => {
  it('reverses the bytes, because ASS is BGR and everything else is RGB', () => {
    expect(assColor('#112233')).toBe('&H00332211')
  })

  it('takes alpha where 0 is opaque, which is the other way round again', () => {
    expect(assColor('#000000', 128)).toBe('&H80000000')
  })

  it('falls back to white rather than emitting something libass will not parse', () => {
    expect(assColor('rebeccapurple')).toBe('&H00FFFFFF')
  })
})

describe('assTime', () => {
  it('writes centiseconds, which is all the format has', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(65.239)).toBe('0:01:05.24')
    expect(assTime(3725.5)).toBe('1:02:05.50')
  })
})

describe('escapeAssText', () => {
  it('defuses the characters that would be read as formatting', () => {
    expect(escapeAssText('a {b} \\c')).toBe('a (b) ∖c')
  })

  it('keeps an event on one line', () => {
    expect(escapeAssText('one\ntwo')).toBe('one two')
  })
})

describe('buildAssFile', () => {
  const line = cue('c1', 0, 3, [
    ['Hello', 0, 0.5],
    ['there', 1, 1.5],
    ['world', 2, 2.5],
  ])

  it('emits one event per word, each carrying the whole line', () => {
    const file = buildAssFile({ ...base, tracks: [track()], cues: [line] })
    const lines = events(file)
    expect(lines).toHaveLength(3)
    for (const entry of lines) {
      expect(textOf(entry)).toContain('Hello')
      expect(textOf(entry)).toContain('there')
      expect(textOf(entry)).toContain('world')
    }
  })

  it('highlights exactly one word at a time, and a different one each event', () => {
    const highlight = assColor(style.highlightColor)
    const highlighted = events(buildAssFile({ ...base, tracks: [track()], cues: [line] })).map(
      (entry) => {
        const found = new RegExp(`\\{\\\\c${highlight}\\}(\\w+)`).exec(textOf(entry))
        expect(textOf(entry).split(highlight)).toHaveLength(2)
        return found?.[1]
      },
    )
    expect(highlighted).toEqual(['Hello', 'there', 'world'])
  })

  it('tiles the caption with no gaps, so the line never flickers mid-sentence', () => {
    const times = events(buildAssFile({ ...base, tracks: [track()], cues: [line] })).map((entry) =>
      entry.split(',').slice(1, 3),
    )
    expect(times).toEqual([
      ['0:00:00.00', '0:00:01.00'],
      ['0:00:01.00', '0:00:02.00'],
      ['0:00:02.00', '0:00:03.00'],
    ])
  })

  it('shows the line unlit for a beat when the caption comes up before the first word', () => {
    const early = cue('c1', 0, 2, [['Hi', 1, 1.5]])
    const lines = events(buildAssFile({ ...base, tracks: [track()], cues: [early] }))
    expect(lines).toHaveLength(2)
    expect(textOf(lines[0]!)).toBe('Hi')
    expect(lines[0]).toContain('0:00:00.00,0:00:01.00')
  })

  it('authors at the export size, so sizes need no scaling factor', () => {
    const file = buildAssFile({ ...base, tracks: [track()], cues: [line] })
    expect(file).toContain('PlayResX: 720')
    expect(file).toContain('PlayResY: 1280')
    // 7.5% of 1280.
    expect(file).toContain(',96,')
  })

  it('turns the position fraction into a bottom margin', () => {
    const styled = track('track-1', {
      style: { ...style, position: 0.5, fontScale: 0.1 },
    })
    // Halfway down a 1280 frame is 640 up from the bottom, less half the 128px
    // line so the middle of the text lands on the mark.
    expect(buildAssFile({ ...base, tracks: [styled], cues: [line] })).toContain(',576,1')
  })

  it('marks the style bold or not, matching what the preview draws', () => {
    // Both weights stated outright rather than leaning on the default, which is
    // a look and free to change; what is asserted here is the mapping onto ASS.
    const bold = buildAssFile({
      ...base,
      tracks: [track('track-1', { style: { ...style, bold: true } })],
      cues: [line],
    })
    const plain = buildAssFile({
      ...base,
      tracks: [track('track-1', { style: { ...style, bold: false } })],
      cues: [line],
    })
    // The font is named as libass will match it: the family inside the file, not
    // the suffixed one the preview's @font-face declares.
    expect(bold).toMatch(/^Style: Cap0,Lindy Toon Wide,96,[^,]+,[^,]+,[^,]+,[^,]+,-1,/m)
    expect(plain).toMatch(/^Style: Cap0,Lindy Toon Wide,96,[^,]+,[^,]+,[^,]+,[^,]+,0,/m)
  })

  it('applies uppercase to the drawn text without touching the transcript', () => {
    const shouty = track('track-1', { style: { ...style, uppercase: true } })
    expect(textOf(events(buildAssFile({ ...base, tracks: [shouty], cues: [line] }))[0]!)).toContain(
      'HELLO',
    )
  })

  it('gives each track its own style, and events that name it', () => {
    const second = cue('c2', 0, 1, [['Otra', 0, 1]], 'track-2')
    const file = buildAssFile({
      ...base,
      tracks: [track(), track('track-2', { style: { ...style, position: 0.2 } })],
      cues: [line, second],
    })
    expect(file).toContain('Style: Cap0,')
    expect(file).toContain('Style: Cap1,')
    expect(events(file).filter((entry) => entry.includes(',Cap1,'))).toHaveLength(1)
  })

  it('writes no events for a caption with no words', () => {
    expect(
      events(buildAssFile({ ...base, tracks: [track()], cues: [cue('c1', 0, 1, [])] })),
    ).toEqual([])
  })
})
