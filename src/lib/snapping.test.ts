import { describe, expect, it } from 'vitest'
import { snapClipStart, snapPointsFor, snapTime, withoutOwnEdges } from './snapping'
import type { AudioClip, Clip, Project, VideoClip } from './types'

const clip = (id: string, inPoint: number, outPoint: number): Clip => ({
  id,
  assetId: `asset-${id}`,
  inPoint,
  outPoint,
})

const audioClip = (id: string, startTime: number, duration: number): AudioClip => ({
  id,
  trackId: 't1',
  assetId: `asset-${id}`,
  useConverted: false,
  startTime,
  inPoint: 0,
  duration,
})

const videoClip = (id: string, startTime: number, duration: number): VideoClip => ({
  id,
  trackId: 'v1',
  assetId: `asset-${id}`,
  startTime,
  inPoint: 0,
  duration,
})

const baseProject: Project = {
  id: 'p1',
  name: 'project',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 1080,
  height: 1920,
  fps: 30,
}

describe('snapPointsFor', () => {
  it('collects the start and end of every clip on the picture track', () => {
    const project: Project = { ...baseProject, clips: [clip('a', 0, 2), clip('b', 0, 3)] }
    expect(snapPointsFor(project)).toEqual([0, 2, 5])
  })

  it('includes the lead-in', () => {
    const project: Project = { ...baseProject, clips: [clip('a', 0, 2)], leadIn: 1.5 }
    expect(snapPointsFor(project)).toEqual([0, 1.5, 3.5])
  })

  it('includes audio clips, video layers and captions', () => {
    const project: Project = {
      ...baseProject,
      audioClips: [audioClip('au', 1, 2)],
      videoClips: [videoClip('vc', 4, 1)],
      captionCues: [{ id: 'c1', trackId: 'ct1', start: 6, end: 7, words: [] }],
    }
    expect(snapPointsFor(project)).toEqual([0, 1, 3, 4, 5, 6, 7])
  })

  it('dedupes points that coincide', () => {
    const project: Project = {
      ...baseProject,
      clips: [clip('a', 0, 2)],
      audioClips: [audioClip('au', 0, 2)],
    }
    expect(snapPointsFor(project)).toEqual([0, 2])
  })
})

describe('withoutOwnEdges', () => {
  it('drops a clip’s own start and end, leaving the rest', () => {
    expect(withoutOwnEdges([0, 2, 5, 7], 2, 5)).toEqual([0, 7])
  })

  it('leaves the points untouched when neither edge appears', () => {
    expect(withoutOwnEdges([0, 3, 6], 1, 2)).toEqual([0, 3, 6])
  })
})

describe('snapTime', () => {
  it('snaps to the nearest point within the threshold', () => {
    expect(snapTime(5.1, [0, 5, 10], 0.5)).toBe(5)
  })

  it('leaves the candidate alone when nothing is close enough', () => {
    expect(snapTime(5.5, [0, 5, 10], 0.2)).toBe(5.5)
  })

  it('picks the closest point when more than one is in range', () => {
    expect(snapTime(4.9, [4.6, 5.3], 1)).toBe(4.6)
  })
})

describe('snapClipStart', () => {
  const points = [0, 5, 10]

  it('snaps the leading edge onto a nearby point', () => {
    // A 2s clip dragged so its start lands just short of the point at 5.
    expect(snapClipStart(4.9, 2, points, 0.5)).toBe(5)
  })

  it('snaps the trailing edge onto a nearby point, carrying the start with it', () => {
    // A 2s clip dragged so its end lands just short of the point at 10 — the
    // start has to move by the same amount to keep the clip's own length.
    expect(snapClipStart(7.9, 2, points, 0.5)).toBe(8)
  })

  it('prefers whichever edge is closer when both are in range', () => {
    // Start is 0.1 from 5; end (9.55) is 0.45 from 10 — the closer edge wins.
    expect(snapClipStart(4.9, 4.65, points, 0.5)).toBe(5)
  })

  it('leaves the start alone when neither edge is close enough to snap', () => {
    expect(snapClipStart(2, 1, points, 0.3)).toBe(2)
  })
})
