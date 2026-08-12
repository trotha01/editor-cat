import { describe, expect, it } from 'vitest'
import { exportRangeOf } from './range'

/**
 * Fitting a chosen start and end to the timeline it was chosen against.
 *
 * The load-bearing claim is the one about "the whole thing": an export nobody
 * has trimmed must come back as *absent*, not as a range that happens to cover
 * everything, because absent is what leaves the filtergraph and the Mintspace
 * fingerprint exactly as they were before ranges existed.
 */
describe('exportRangeOf', () => {
  it('has nothing to say about an export with no range at all', () => {
    expect(exportRangeOf(null, 10)).toBeUndefined()
    expect(exportRangeOf(undefined, 10)).toBeUndefined()
  })

  it('reads a range covering the whole timeline as no range', () => {
    expect(exportRangeOf({ start: 0, end: 10 }, 10)).toBeUndefined()
  })

  it('ignores float noise at either end rather than calling it a trim', () => {
    // What comes back from formatting a duration to two decimals and reading it
    // in again — not a cut anybody asked for.
    expect(exportRangeOf({ start: 0.0004, end: 9.9996 }, 10)).toBeUndefined()
  })

  it('keeps a range that really does cut something', () => {
    expect(exportRangeOf({ start: 2, end: 6 }, 10)).toEqual({ start: 2, end: 6 })
  })

  it('keeps a trim at one end only', () => {
    expect(exportRangeOf({ start: 0, end: 6 }, 10)).toEqual({ start: 0, end: 6 })
    expect(exportRangeOf({ start: 4, end: 10 }, 10)).toEqual({ start: 4, end: 10 })
  })

  it('fits a range asking for picture the timeline no longer has', () => {
    expect(exportRangeOf({ start: 2, end: 40 }, 10)).toEqual({ start: 2, end: 10 })
  })

  it('never hands back a negative length for the encoder to choke on', () => {
    expect(exportRangeOf({ start: 8, end: 3 }, 10)).toEqual({ start: 8, end: 8 })
  })

  it('treats a start beyond the end of the timeline as its end', () => {
    expect(exportRangeOf({ start: 40, end: 50 }, 10)).toEqual({ start: 10, end: 10 })
  })
})
