import { describe, expect, it } from 'vitest'
import { MIN_EXPORT_LENGTH, clampExportRange, isWholeTimeline } from './range'

describe('clampExportRange', () => {
  it('is the whole timeline when nothing was asked for', () => {
    expect(clampExportRange(undefined, 12)).toEqual({ start: 0, end: 12 })
  })

  it('keeps a range that already fits', () => {
    expect(clampExportRange({ start: 2, end: 9 }, 12)).toEqual({ start: 2, end: 9 })
  })

  it('pulls an end past the timeline back to it', () => {
    expect(clampExportRange({ start: 2, end: 40 }, 12)).toEqual({ start: 2, end: 12 })
  })

  it('never lets the end sit at or before the start', () => {
    // Both boxes are typed in, so back-to-front is an ordinary state on the way
    // to a sensible one rather than something to refuse.
    const range = clampExportRange({ start: 8, end: 3 }, 12)
    expect(range.start).toBe(8)
    expect(range.end).toBeCloseTo(8 + MIN_EXPORT_LENGTH)
  })

  it('leaves room for an export after a start past the end of the timeline', () => {
    const range = clampExportRange({ start: 99, end: 99 }, 12)
    expect(range.start).toBeCloseTo(12 - MIN_EXPORT_LENGTH)
    expect(range.end).toBe(12)
  })

  it('reads a half-typed box as the bound it is nearest', () => {
    // Number('') is 0 and Number('1.2.3') is NaN; neither should empty the
    // dialog or produce a range nothing can be rendered from.
    expect(clampExportRange({ start: Number.NaN, end: Number.NaN }, 12)).toEqual({
      start: 0,
      end: MIN_EXPORT_LENGTH,
    })
  })

  it('gives up on a timeline too short to divide', () => {
    expect(clampExportRange({ start: 0.02, end: 0.04 }, 0.05)).toEqual({ start: 0, end: 0.05 })
  })

  it('treats a timeline of no length as no length', () => {
    expect(clampExportRange({ start: 1, end: 2 }, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('isWholeTimeline', () => {
  it('recognises the full span', () => {
    expect(isWholeTimeline({ start: 0, end: 12 }, 12)).toBe(true)
  })

  it('recognises a narrowed one at either end', () => {
    expect(isWholeTimeline({ start: 0.5, end: 12 }, 12)).toBe(false)
    expect(isWholeTimeline({ start: 0, end: 11.5 }, 12)).toBe(false)
  })
})
