import { describe, expect, it } from 'vitest'
import {
  MIN_CLIP_DURATION,
  clipAtTime,
  clipDuration,
  clipForAsset,
  formatTime,
  layoutClips,
  projectDuration,
  reorder,
  sourceTimeFor,
  totalDuration,
  trimClip,
} from './timeline'
import type { Asset, Clip, Project } from './types'

const image: Asset = {
  id: 'a-img',
  kind: 'image',
  blobKey: 'b1',
  mimeType: 'image/png',
  name: 'still',
  createdAt: 0,
}

const video: Asset = {
  id: 'a-vid',
  kind: 'video',
  blobKey: 'b2',
  mimeType: 'video/mp4',
  name: 'clip',
  duration: 10,
  createdAt: 0,
}

const clip = (id: string, inPoint: number, outPoint: number, assetId = 'a-vid'): Clip => ({
  id,
  assetId,
  inPoint,
  outPoint,
})

describe('layoutClips', () => {
  it('lays clips end to end with no gaps', () => {
    const laid = layoutClips([clip('1', 0, 3), clip('2', 2, 4.5), clip('3', 0, 1)])

    expect(laid.map((entry) => [entry.start, entry.end])).toEqual([
      [0, 3],
      [3, 5.5],
      [5.5, 6.5],
    ])
  })

  it('starts a trimmed clip at the end of the previous one, not at its in-point', () => {
    // A trim must pull later clips earlier — this is the whole point of a
    // gapless track, and getting it wrong leaves black frames in the export.
    const laid = layoutClips([clip('1', 5, 6), clip('2', 0, 2)])
    expect(laid[1]?.start).toBe(1)
  })

  it('returns an empty layout for an empty timeline', () => {
    expect(layoutClips([])).toEqual([])
  })
})

describe('totalDuration', () => {
  it('sums clip lengths', () => {
    expect(totalDuration([clip('1', 0, 2), clip('2', 1, 4)])).toBe(5)
  })

  it('ignores inverted clips rather than subtracting time', () => {
    expect(totalDuration([clip('1', 5, 2)])).toBe(0)
  })
})

describe('clipAtTime', () => {
  const clips = [clip('1', 0, 2), clip('2', 0, 3)]

  it('finds the clip covering a time', () => {
    expect(clipAtTime(clips, 0)?.clip.id).toBe('1')
    expect(clipAtTime(clips, 1.99)?.clip.id).toBe('1')
    expect(clipAtTime(clips, 2)?.clip.id).toBe('2')
    expect(clipAtTime(clips, 4.9)?.clip.id).toBe('2')
  })

  it('assigns a boundary to exactly one clip', () => {
    // If both clips claimed t=2 the preview would flicker between them.
    expect(clipAtTime(clips, 2)?.clip.id).toBe('2')
  })

  it('holds the last clip at the very end instead of going blank', () => {
    expect(clipAtTime(clips, 5)?.clip.id).toBe('2')
  })

  it('returns null past the end and before the start', () => {
    expect(clipAtTime(clips, 5.1)).toBeNull()
    expect(clipAtTime(clips, -1)).toBeNull()
    expect(clipAtTime([], 0)).toBeNull()
  })
})

describe('sourceTimeFor', () => {
  it('maps timeline time onto the source, honouring the in-point', () => {
    const laid = layoutClips([clip('1', 0, 2), clip('2', 6, 9)])
    const second = laid[1]!
    expect(sourceTimeFor(second, 2)).toBe(6)
    expect(sourceTimeFor(second, 3.5)).toBe(7.5)
  })

  it('clamps rather than running off the end of the source', () => {
    const laid = layoutClips([clip('1', 6, 9)])
    expect(sourceTimeFor(laid[0]!, 99)).toBe(9)
    expect(sourceTimeFor(laid[0]!, -5)).toBe(6)
  })
})

describe('trimClip', () => {
  it('moves the in-point when dragging the start', () => {
    expect(trimClip(clip('1', 0, 8), video, 'start', 3).inPoint).toBe(3)
  })

  it('never lets the start cross the end', () => {
    const trimmed = trimClip(clip('1', 0, 5), video, 'start', 9)
    expect(trimmed.inPoint).toBeCloseTo(5 - MIN_CLIP_DURATION)
    expect(trimmed.inPoint).toBeLessThan(trimmed.outPoint)
  })

  it('clamps the end to the length of the source video', () => {
    // Asking for 30s of a 10s clip would otherwise produce a frozen tail.
    expect(trimClip(clip('1', 0, 5), video, 'end', 30).outPoint).toBe(10)
  })

  it('keeps the end at least a minimum length past the start', () => {
    const trimmed = trimClip(clip('1', 4, 8), video, 'end', 1)
    expect(trimmed.outPoint).toBeCloseTo(4 + MIN_CLIP_DURATION)
  })

  it('ignores start trims on stills, which have no in-point to move', () => {
    const original = clip('1', 0, 4, 'a-img')
    expect(trimClip(original, image, 'start', 2)).toEqual(original)
  })

  it('lets a still be held far longer than any source duration', () => {
    expect(trimClip(clip('1', 0, 4, 'a-img'), image, 'end', 30).outPoint).toBe(30)
  })

  it('falls back safely when the asset has gone missing', () => {
    const trimmed = trimClip(clip('1', 0, 4), undefined, 'end', 100)
    expect(Number.isFinite(trimmed.outPoint)).toBe(true)
    expect(clipDuration(trimmed)).toBeGreaterThanOrEqual(MIN_CLIP_DURATION)
  })

  it('does not mutate the clip it was given', () => {
    const original = clip('1', 0, 4)
    trimClip(original, video, 'end', 2)
    expect(original.outPoint).toBe(4)
  })
})

describe('clipForAsset', () => {
  it('gives a still a default on-screen duration', () => {
    expect(clipDuration(clipForAsset(image, 'c'))).toBe(4)
  })

  it('gives a video its full length', () => {
    expect(clipForAsset(video, 'c')).toMatchObject({ inPoint: 0, outPoint: 10 })
  })

  it('falls back to a default when a video reports no duration', () => {
    const unknown = { ...video, duration: undefined }
    expect(clipDuration(clipForAsset(unknown, 'c'))).toBeGreaterThan(0)
  })
})

describe('reorder', () => {
  it('moves an item to a new index', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op for out-of-range or identical indices', () => {
    expect(reorder(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(reorder(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(reorder(['a', 'b'], 0, 9)).toEqual(['a', 'b'])
  })

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c']
    reorder(input, 0, 2)
    expect(input).toEqual(['a', 'b', 'c'])
  })
})

describe('projectDuration', () => {
  const base: Project = {
    id: 'p',
    name: 'p',
    clips: [clip('1', 0, 3)],
    audioTracks: [],
    audioClips: [],
    width: 1280,
    height: 720,
    fps: 30,
  }

  it('uses the visual length when no voiceover runs past it', () => {
    expect(projectDuration(base)).toBe(3)
  })

  it('extends to cover audio that outlasts the clips', () => {
    const project: Project = {
      ...base,
      audioClips: [
        {
          id: 'v',
          trackId: 't',
          assetId: 'a',
          useConverted: false,
          startTime: 2,
          inPoint: 0,
          duration: 6,
        },
      ],
    }
    expect(projectDuration(project)).toBe(8)
  })
})

describe('formatTime', () => {
  it('formats minutes and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(9.25)).toBe('0:09.3')
    expect(formatTime(75)).toBe('1:15.0')
  })

  it('does not blow up on nonsense input', () => {
    expect(formatTime(Number.NaN)).toBe('0:00.0')
    expect(formatTime(-4)).toBe('0:00.0')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.0')
  })
})
