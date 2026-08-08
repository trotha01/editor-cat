import { describe, expect, it } from 'vitest'
import {
  UNKNOWN,
  bufferedFraction,
  quantise,
  readinessFor,
  sameReadiness,
  summarise,
  type ClipReadiness,
  type Ranges,
} from './readiness'

/**
 * What the readiness indicator is allowed to claim.
 *
 * The whole feature is only worth having if it is trusted, and the way to lose
 * that is to say "ready" about a clip that then hitches, or to sit there
 * reporting "loading" about clips nothing has asked for. So these tests are
 * mostly about the boundaries between the states rather than the arithmetic.
 */

/** A stand-in for `TimeRanges`, which jsdom has no way to build. */
function ranges(...pairs: [number, number][]): Ranges {
  return {
    length: pairs.length,
    start: (index) => pairs[index]?.[0] ?? 0,
    end: (index) => pairs[index]?.[1] ?? 0,
  }
}

describe('how much of a clip is buffered', () => {
  it('is none of it when the element has nothing', () => {
    expect(bufferedFraction(ranges(), 0, 4)).toBe(0)
    expect(bufferedFraction(null, 0, 4)).toBe(0)
  })

  it('is all of it when the range is covered', () => {
    expect(bufferedFraction(ranges([0, 10]), 2, 6)).toBe(1)
  })

  it('counts only the part that overlaps', () => {
    // Buffered from the top of the file, but this clip starts at 2.
    expect(bufferedFraction(ranges([0, 4]), 2, 6)).toBe(0.5)
  })

  it('ignores buffering outside the clip entirely', () => {
    // The exact case the in-point seek exists for: a browser that has fetched
    // the head of a long source has fetched nothing this clip will ever show.
    expect(bufferedFraction(ranges([0, 30]), 120, 125)).toBe(0)
  })

  it('adds up the separate ranges a seek leaves behind', () => {
    expect(bufferedFraction(ranges([0, 1], [2, 3], [5, 9]), 0, 4)).toBe(0.5)
  })

  it('treats a zero-length clip as covered, rather than as forever pending', () => {
    expect(bufferedFraction(ranges(), 3, 3)).toBe(1)
    expect(bufferedFraction(ranges(), 3, 2)).toBe(1)
  })

  it('never exceeds all of it, whatever the ranges say', () => {
    expect(bufferedFraction(ranges([0, 10], [0, 10]), 0, 4)).toBe(1)
  })
})

describe('what state a clip is in', () => {
  const base = { readyState: 4, buffered: 1, wanted: false, warm: true }

  it('is ready once the clip’s own range is buffered', () => {
    expect(readinessFor(base)).toEqual({ state: 'ready', buffered: 1 })
  })

  it('is ready a hair short of the end, which is where buffering stops', () => {
    // Ranges routinely end a few sample-widths early and still play through.
    expect(readinessFor({ ...base, buffered: 0.997 }).state).toBe('ready')
  })

  it('is loading while a clip near the playhead is still filling', () => {
    expect(readinessFor({ ...base, readyState: 1, buffered: 0.4 })).toEqual({
      state: 'loading',
      buffered: 0.4,
    })
  })

  it('is idle for a clip we have deliberately not fetched', () => {
    // Not a problem and not worth an alarm: nothing has asked for it yet.
    expect(readinessFor({ ...base, readyState: 0, buffered: 0, warm: false })).toEqual({
      state: 'idle',
      buffered: 0,
    })
  })

  it('is stalled only when the playhead is actually on it', () => {
    const starved = { ...base, readyState: 2, buffered: 0.1 }

    expect(readinessFor({ ...starved, wanted: false }).state).toBe('loading')
    expect(readinessFor({ ...starved, wanted: true }).state).toBe('stalled')
  })

  it('is not stalled while the element has data to run on', () => {
    // HAVE_FUTURE_DATA is the line: it can advance past the frame it is on,
    // which is all playback needs from it this instant.
    expect(readinessFor({ ...base, readyState: 3, buffered: 0.2, wanted: true }).state).toBe(
      'loading',
    )
  })

  it('is missing when the media failed, whatever else is true of it', () => {
    expect(readinessFor({ ...base, failed: true })).toEqual({ state: 'missing', buffered: 0 })
  })
})

describe('the summary over the picture', () => {
  const ready: ClipReadiness = { state: 'ready', buffered: 1 }
  const loading: ClipReadiness = { state: 'loading', buffered: 0.3 }
  const stalled: ClipReadiness = { state: 'stalled', buffered: 0.1 }
  const missing: ClipReadiness = { state: 'missing', buffered: 0 }
  const idle: ClipReadiness = { state: 'idle', buffered: 0 }

  it('says nothing is outstanding when everything is loaded', () => {
    expect(summarise(['a', 'b'], { a: ready, b: ready })).toEqual({
      missing: 0,
      loading: 0,
      idle: 0,
      stalled: false,
      total: 2,
    })
  })

  it('does not count clips we have not asked for as late', () => {
    // Otherwise a long timeline permanently accuses itself of loading.
    const summary = summarise(['a', 'b', 'c'], { a: ready, b: idle, c: idle })

    expect(summary.loading).toBe(0)
    expect(summary.idle).toBe(2)
  })

  it('counts a stalled clip as loading too, because it is', () => {
    const summary = summarise(['a', 'b'], { a: stalled, b: loading })

    expect(summary.loading).toBe(2)
    expect(summary.stalled).toBe(true)
  })

  it('counts missing media separately from slow media', () => {
    const summary = summarise(['a', 'b'], { a: missing, b: loading })

    expect(summary).toMatchObject({ missing: 1, loading: 1, stalled: false })
  })

  it('treats a clip nothing has reported on as idle, not as loaded', () => {
    // Claiming "all ready" about media nothing has looked at is the one lie
    // that would make the indicator not worth having.
    expect(summarise(['a'], {})).toMatchObject({ idle: 1, loading: 0, missing: 0 })
    expect(UNKNOWN.state).toBe('idle')
  })
})

describe('keeping the store quiet', () => {
  it('rounds to whole percent, so creeping progress is not a re-render', () => {
    expect(quantise({ state: 'loading', buffered: 0.41666 })).toEqual({
      state: 'loading',
      buffered: 0.42,
    })
  })

  it('spots the readings that would look identical', () => {
    const a: ClipReadiness = { state: 'loading', buffered: 0.5 }

    expect(sameReadiness(a, { state: 'loading', buffered: 0.5 })).toBe(true)
    expect(sameReadiness(a, { state: 'loading', buffered: 0.51 })).toBe(false)
    expect(sameReadiness(a, { state: 'stalled', buffered: 0.5 })).toBe(false)
  })
})
