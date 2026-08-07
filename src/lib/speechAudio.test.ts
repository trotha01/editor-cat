import { describe, expect, it } from 'vitest'
import { CHUNK_SECONDS, chunkRanges } from './speechAudio'

describe('chunkRanges', () => {
  it('sends a source that fits in one request as one request', () => {
    expect(chunkRanges(0, 30)).toEqual([{ from: 0, to: 30 }])
  })

  it('starts from the in-point, so a trimmed clip is not transcribed from the top', () => {
    expect(chunkRanges(12, 20)).toEqual([{ from: 12, to: 20 }])
  })

  it('cuts a long source into chunks that tile it exactly', () => {
    const ranges = chunkRanges(0, 300)
    // Counted from the constant rather than written out, since the payload the
    // chunk is sized against is a property of the transport and has changed
    // once already — what has to hold is the tiling, not the number.
    expect(ranges).toHaveLength(Math.ceil(300 / CHUNK_SECONDS))
    expect(ranges[0]).toEqual({ from: 0, to: CHUNK_SECONDS })
    expect(ranges.at(-1)?.to).toBe(300)
    // No gaps and no overlaps: every second of audio is transcribed once.
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]?.from).toBe(ranges[index - 1]?.to)
    }
  })

  it('never produces a chunk longer than the payload allows', () => {
    for (const range of chunkRanges(5, 700)) {
      expect(range.to - range.from).toBeLessThanOrEqual(CHUNK_SECONDS)
    }
  })

  it('is a no-op range for a source with no length', () => {
    expect(chunkRanges(4, 4)).toEqual([{ from: 4, to: 4 }])
    expect(chunkRanges(9, 2)).toEqual([{ from: 9, to: 9 }])
  })
})
