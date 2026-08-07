import { describe, expect, it } from 'vitest'
import {
  MIN_OVERLAY_DURATION,
  addVideoTrack,
  createVideoTrack,
  laneForClip,
  layerGain,
  layersAt,
  moveVideoClip,
  nextVideoTrackName,
  opacityFor,
  trimVideoClip,
  videoClipForAsset,
  videoClipsOf,
  videoLayersEnd,
  videoTrackHasRoom,
  videoTracksOf,
} from './videoTracks'
import type { Asset, VideoClip, VideoTrack } from './types'

/**
 * Picture laid over picture.
 *
 * Two things here are worth more than the rest. Stacking order, because it
 * decides what you actually see and is the one thing a layer is *for*; and the
 * refusal to overlap, because a lane holding two clips at once has no answer to
 * "which of you is on top" and the mistake would only show on export.
 */

const track = (id: string, extra: Partial<VideoTrack> = {}): VideoTrack => ({
  id,
  name: id,
  hidden: false,
  opacity: 1,
  ...extra,
})

const clip = (
  id: string,
  trackId: string,
  startTime: number,
  duration: number,
  extra: Partial<VideoClip> = {},
): VideoClip => ({
  id,
  trackId,
  assetId: `asset-${id}`,
  startTime,
  inPoint: 0,
  duration,
  ...extra,
})

const video: Asset = {
  id: 'a-vid',
  kind: 'video',
  blobKey: 'b',
  mimeType: 'video/mp4',
  name: 'clip',
  duration: 10,
  createdAt: 0,
}

const image: Asset = {
  id: 'a-img',
  kind: 'image',
  blobKey: 'b',
  mimeType: 'image/png',
  name: 'still',
  createdAt: 0,
}

describe('reading a project that has no lanes', () => {
  it('sees none rather than blowing up', () => {
    // Every project saved before layering existed is this shape.
    expect(videoTracksOf({})).toEqual([])
    expect(videoClipsOf({})).toEqual([])
  })
})

describe('adding a lane', () => {
  it('goes on top of the others, because that is what asking for one means', () => {
    const tracks = addVideoTrack([track('v1')], 'v2')
    expect(tracks.map((entry) => entry.id)).toEqual(['v1', 'v2'])
  })

  it('numbers lanes and skips a name already taken', () => {
    expect(nextVideoTrackName([])).toBe('Video 1')
    expect(nextVideoTrackName([track('a', { name: 'Video 1' })])).toBe('Video 2')
  })

  it('starts opaque and visible', () => {
    expect(createVideoTrack('v1', [])).toMatchObject({ hidden: false, opacity: 1 })
  })
})

describe('placing a clip on a lane', () => {
  it('takes the first lane with room at that moment', () => {
    const tracks = [track('v1'), track('v2')]
    const clips = [clip('a', 'v1', 0, 5)]
    expect(laneForClip(tracks, clips, { startTime: 1, duration: 1 })?.id).toBe('v2')
  })

  it('finds nowhere when every lane is busy, so the caller makes one', () => {
    const tracks = [track('v1')]
    const clips = [clip('a', 'v1', 0, 5)]
    expect(laneForClip(tracks, clips, { startTime: 1, duration: 1 })).toBeNull()
  })

  it('gives a video its own length and a still a default', () => {
    expect(videoClipForAsset(video, 'c', 'v1', 2)).toMatchObject({ duration: 10, startTime: 2 })
    expect(videoClipForAsset(image, 'c', 'v1', 0).duration).toBeGreaterThan(0)
  })

  it('never starts a clip before the timeline does', () => {
    expect(videoClipForAsset(video, 'c', 'v1', -5).startTime).toBe(0)
  })
})

describe('moving a layer', () => {
  const clips = [clip('a', 'v1', 0, 2), clip('b', 'v2', 5, 2)]

  it('retimes it along its own lane', () => {
    const result = moveVideoClip(clips, 'a', { startTime: 3 })
    expect(result.moved).toBe(true)
    expect(result.clips[0]?.startTime).toBe(3)
  })

  it('moves it to another lane, which is how a shot is restacked', () => {
    const result = moveVideoClip(clips, 'a', { startTime: 0, trackId: 'v2' })
    expect(result.moved).toBe(true)
    expect(result.clips[0]?.trackId).toBe('v2')
  })

  it('refuses a move onto another layer rather than overlapping it', () => {
    // A lane with two clips at once has no answer to which is on top.
    const result = moveVideoClip(clips, 'a', { startTime: 6, trackId: 'v2' })
    expect(result.moved).toBe(false)
    expect(result.clips[0]?.startTime).toBe(0)
  })

  it('lets a clip pass over its own old position', () => {
    const result = moveVideoClip(clips, 'a', { startTime: 0.5 })
    expect(result.moved).toBe(true)
  })

  it('reports room honestly', () => {
    expect(videoTrackHasRoom(clips, 'v1', { startTime: 3, duration: 1 })).toBe(true)
    expect(videoTrackHasRoom(clips, 'v1', { startTime: 1, duration: 1 })).toBe(false)
    expect(videoTrackHasRoom(clips, 'v1', { startTime: 1, duration: 1 }, 'a')).toBe(true)
  })
})

describe('trimming a layer', () => {
  it('keeps the remaining frames where they were on the timeline', () => {
    // The whole reason to place a layer by hand is to hit a moment. Trimming
    // the head off and letting the rest slide left would move it off that
    // moment, which is the opposite of what a trim is for.
    const trimmed = trimVideoClip(clip('a', 'v1', 10, 4), video, 'start', 1)
    expect(trimmed).toMatchObject({ inPoint: 1, startTime: 11, duration: 3 })
  })

  it('shortens from the end without moving the start', () => {
    const trimmed = trimVideoClip(clip('a', 'v1', 10, 4), video, 'end', 2)
    expect(trimmed).toMatchObject({ startTime: 10, duration: 2 })
  })

  it('never moves the tail while the head is being pulled', () => {
    // Dragged further left than there is timeline in front of it. Clamping the
    // resulting start time on its own let the in-point and the duration go on
    // describing a longer clip, so the tail slid right and every frame with it.
    const before = clip('a', 'v1', 0.5, 4, { inPoint: 2 })
    const after = trimVideoClip(before, video, 'start', 0)

    expect(after.startTime).toBe(0)
    expect(after.startTime + after.duration).toBeCloseTo(before.startTime + before.duration, 6)
  })

  it('keeps every remaining frame at the moment it was already at', () => {
    const sourceAt = (entry: VideoClip, t: number) => entry.inPoint + (t - entry.startTime)
    const before = clip('a', 'v1', 0.5, 4, { inPoint: 2 })
    const after = trimVideoClip(before, video, 'start', 0)

    expect(sourceAt(after, 2)).toBeCloseTo(sourceAt(before, 2), 6)
    expect(after.inPoint).toBeGreaterThanOrEqual(0)
  })

  it('never trims a layer away to nothing', () => {
    const trimmed = trimVideoClip(clip('a', 'v1', 0, 4), video, 'end', -5)
    expect(trimmed.duration).toBeCloseTo(MIN_OVERLAY_DURATION)
  })

  it('clamps the end to the length of the source', () => {
    expect(trimVideoClip(clip('a', 'v1', 0, 4), video, 'end', 99).duration).toBe(10)
  })

  it('ignores a start trim on a still, which has no in-point', () => {
    const original = clip('a', 'v1', 0, 4)
    expect(trimVideoClip(original, image, 'start', 2)).toEqual(original)
  })

  it('lets a still be held far past any source duration', () => {
    expect(trimVideoClip(clip('a', 'v1', 0, 4), image, 'end', 30).duration).toBe(30)
  })

  it('does not mutate the clip it was given', () => {
    const original = clip('a', 'v1', 5, 4)
    trimVideoClip(original, video, 'start', 2)
    expect(original).toMatchObject({ startTime: 5, inPoint: 0, duration: 4 })
  })
})

describe('what is on screen at a moment', () => {
  const tracks = [track('v1'), track('v2')]
  const clips = [clip('a', 'v1', 0, 4), clip('b', 'v2', 2, 4)]

  it('finds the layers covering that time', () => {
    expect(layersAt(tracks, clips, 3).map((layer) => layer.clip.id)).toEqual(['a', 'b'])
    expect(layersAt(tracks, clips, 5).map((layer) => layer.clip.id)).toEqual(['b'])
    expect(layersAt(tracks, clips, 7)).toEqual([])
  })

  it('orders them by lane, bottom of the stack first', () => {
    // Read off the clip list instead and whichever was added first would end up
    // at the bottom — so moving a clip would silently restack the frame.
    const jumbled = [clip('b', 'v2', 0, 4), clip('a', 'v1', 0, 4)]
    expect(layersAt(tracks, jumbled, 1).map((layer) => layer.clip.id)).toEqual(['a', 'b'])
  })

  it('leaves out a hidden lane', () => {
    expect(layersAt([track('v1', { hidden: true })], clips, 1)).toEqual([])
  })

  it('maps the moment onto the right frame of the source', () => {
    const trimmed = [clip('a', 'v1', 10, 4, { inPoint: 6 })]
    expect(layersAt([track('v1')], trimmed, 11.5)?.[0]?.sourceTime).toBe(7.5)
  })

  it('ends a layer before its end time, so a boundary belongs to one clip', () => {
    expect(layersAt(tracks, [clip('a', 'v1', 0, 4)], 4)).toEqual([])
  })
})

describe('how a layer draws and sounds', () => {
  it('takes its opacity from its lane', () => {
    expect(opacityFor([track('v1', { opacity: 0.4 })], clip('a', 'v1', 0, 1))).toBe(0.4)
  })

  it('is invisible on a hidden lane, or one that has been deleted', () => {
    expect(opacityFor([track('v1', { hidden: true })], clip('a', 'v1', 0, 1))).toBe(0)
    expect(opacityFor([], clip('a', 'gone', 0, 1))).toBe(0)
  })

  it('plays its own sound at unity unless told otherwise', () => {
    expect(layerGain([track('v1')], clip('a', 'v1', 0, 1))).toBe(1)
    expect(layerGain([track('v1')], clip('a', 'v1', 0, 1, { volume: 0.3 }))).toBe(0.3)
    expect(layerGain([track('v1')], clip('a', 'v1', 0, 1, { muted: true }))).toBe(0)
  })

  it('is silent on a hidden lane, not merely invisible', () => {
    // Picture gone and dialogue still playing is not a state anyone means to be
    // in, and it would be a puzzle to diagnose from the export.
    expect(layerGain([track('v1', { hidden: true })], clip('a', 'v1', 0, 1))).toBe(0)
  })
})

describe('how long the layers run', () => {
  it('reaches the end of the last one', () => {
    expect(videoLayersEnd([clip('a', 'v1', 0, 2), clip('b', 'v2', 8, 3)])).toBe(11)
  })

  it('is nothing when there are none', () => {
    expect(videoLayersEnd([])).toBe(0)
  })
})
