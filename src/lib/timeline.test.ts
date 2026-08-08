import { describe, expect, it } from 'vitest'
import {
  MAX_LEAD_IN,
  MIN_CLIP_DURATION,
  activeClipsAt,
  clipAtTime,
  clipDuration,
  clipForAsset,
  clipGain,
  clipStartDeltas,
  cutTargetAt,
  formatTime,
  formatTimecode,
  frameDuration,
  isThroughCut,
  joinCutAt,
  layoutClips,
  leadInOf,
  maxTransitionIn,
  projectDuration,
  reorder,
  snapToFrame,
  stepFrames,
  sourceTimeFor,
  splitClipAt,
  totalDuration,
  transitionInFor,
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

  it('starts the whole strip after a lead-in, still with no gaps in it', () => {
    const laid = layoutClips([clip('1', 0, 3), clip('2', 0, 2)], 4)

    expect(laid.map((entry) => [entry.start, entry.end])).toEqual([
      [4, 7],
      [7, 9],
    ])
  })

  it('refuses a lead-in that is negative or nonsense', () => {
    expect(layoutClips([clip('1', 0, 3)], -5)[0]?.start).toBe(0)
    expect(layoutClips([clip('1', 0, 3)], Number.NaN)[0]?.start).toBe(0)
  })

  it('caps an absurd lead-in rather than exporting an hour of black', () => {
    expect(layoutClips([clip('1', 0, 3)], 10_000)[0]?.start).toBe(MAX_LEAD_IN)
  })

  it('pulls a dissolving clip back into the tail of the one before it', () => {
    const laid = layoutClips([clip('1', 0, 3), { ...clip('2', 0, 4), transitionIn: 1 }])

    // The first clip's own end is untouched — only where the second one
    // starts moves, which is what makes the two overlap for 1s.
    expect(laid.map((entry) => [entry.start, entry.end])).toEqual([
      [0, 3],
      [2, 6],
    ])
    expect(laid.map((entry) => entry.transitionIn)).toEqual([0, 1])
  })

  it('clamps a transition to whatever the shorter of the two clips can supply', () => {
    // Clip 1 is only 1s long, so a 5s transition can borrow at most that much.
    const laid = layoutClips([clip('1', 0, 1), { ...clip('2', 0, 4), transitionIn: 5 }])
    expect(laid[1]?.start).toBe(0)
    expect(laid[1]?.transitionIn).toBe(1)
  })

  it('ignores a transition on the first clip, which has nothing before it to dissolve from', () => {
    const laid = layoutClips([{ ...clip('1', 0, 3), transitionIn: 1 }])
    expect(laid[0]?.start).toBe(0)
    expect(laid[0]?.transitionIn).toBe(0)
  })
})

describe('maxTransitionIn', () => {
  it('is zero with no previous clip', () => {
    expect(maxTransitionIn(clip('1', 0, 3), undefined)).toBe(0)
  })

  it('is capped by whichever of the two clips is shorter', () => {
    expect(maxTransitionIn(clip('2', 0, 10), clip('1', 0, 2))).toBe(2)
    expect(maxTransitionIn(clip('2', 0, 2), clip('1', 0, 10))).toBe(2)
  })
})

describe('transitionInFor', () => {
  it('reads the stored value back when it fits', () => {
    expect(transitionInFor({ ...clip('2', 0, 4), transitionIn: 1 }, clip('1', 0, 4))).toBe(1)
  })

  it('is zero when absent, the same as a clip saved before dissolves existed', () => {
    expect(transitionInFor(clip('2', 0, 4), clip('1', 0, 4))).toBe(0)
  })

  it('narrows automatically once a trim shrinks the room a dissolve had', () => {
    // The stored value is left alone; only what can actually be honoured
    // shrinks, exactly like leadInOf clamping a stored lead-in.
    const wide = { ...clip('2', 0, 4), transitionIn: 3 }
    expect(transitionInFor(wide, clip('1', 0, 1))).toBe(1)
  })
})

describe('leadInOf', () => {
  it('reads none from a project saved before lead-ins existed', () => {
    expect(leadInOf({})).toBe(0)
  })

  it('reads the value when there is one', () => {
    expect(leadInOf({ leadIn: 2.5 })).toBe(2.5)
  })
})

describe('totalDuration', () => {
  it('sums clip lengths', () => {
    expect(totalDuration([clip('1', 0, 2), clip('2', 1, 4)])).toBe(5)
  })

  it('ignores inverted clips rather than subtracting time', () => {
    expect(totalDuration([clip('1', 5, 2)])).toBe(0)
  })

  it('counts a dissolve once, not twice', () => {
    // 2s + 3s of clip with 1s shared between them is 4s of screen time, not 5.
    const total = totalDuration([clip('1', 0, 2), { ...clip('2', 0, 3), transitionIn: 1 }])
    expect(total).toBe(4)
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

  it('shows nothing during a lead-in, then the first clip', () => {
    // Black while the count-in plays. Holding the first frame there instead
    // would be worse than useless: it would look like playback had stalled.
    expect(clipAtTime(clips, 1, 3)).toBeNull()
    expect(clipAtTime(clips, 2.99, 3)).toBeNull()
    expect(clipAtTime(clips, 3, 3)?.clip.id).toBe('1')
    expect(clipAtTime(clips, 5, 3)?.clip.id).toBe('2')
  })

  it('is the outgoing clip during a dissolve', () => {
    // clipAtTime only ever hands back one clip — activeClipsAt is what a
    // caller rendering the blend actually wants.
    const dissolving = [clip('1', 0, 3), { ...clip('2', 0, 3), transitionIn: 1 }]
    expect(clipAtTime(dissolving, 2.5)?.clip.id).toBe('1')
  })
})

describe('activeClipsAt', () => {
  const dissolving = [clip('1', 0, 3), { ...clip('2', 0, 3), transitionIn: 1 }]

  it('holds just one clip outside a dissolve', () => {
    expect(activeClipsAt(dissolving, 1).map((entry) => entry.clip.id)).toEqual(['1'])
    expect(activeClipsAt(dissolving, 4).map((entry) => entry.clip.id)).toEqual(['2'])
  })

  it('holds both clips through the dissolve, outgoing then incoming', () => {
    // The overlap runs from 2s (3s clip-1 end minus the 1s transition) to 3s.
    expect(activeClipsAt(dissolving, 2.5).map((entry) => entry.clip.id)).toEqual(['1', '2'])
  })

  it('holds just the last clip at the very end, same as clipAtTime', () => {
    expect(activeClipsAt(dissolving, 5).map((entry) => entry.clip.id)).toEqual(['2'])
  })

  it('returns nothing past the end and before the start', () => {
    expect(activeClipsAt(dissolving, 5.1)).toEqual([])
    expect(activeClipsAt(dissolving, -1)).toEqual([])
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

describe('snapToFrame', () => {
  it('rounds to the nearest frame', () => {
    expect(snapToFrame(1.02, 30)).toBeCloseTo(1 + frameDuration(30), 10)
    expect(snapToFrame(1.01, 30)).toBe(1)
  })

  it('lands exactly on whole seconds rather than a float near them', () => {
    // Counting frames and dividing keeps this exact; multiplying a frame's
    // length by 30 does not, and the cut would then miss the line drawn for it.
    expect(snapToFrame(1, 30)).toBe(1)
    expect(snapToFrame(7, 24)).toBe(7)
  })

  it('is idempotent, so snapping an already-snapped time changes nothing', () => {
    const once = snapToFrame(3.317, 30)
    expect(snapToFrame(once, 30)).toBe(once)
  })

  it('falls back to a sane rate rather than dividing by nonsense', () => {
    expect(snapToFrame(1.02, 0)).toBe(snapToFrame(1.02, 30))
    expect(snapToFrame(Number.NaN, 30)).toBe(0)
    expect(snapToFrame(-3, 30)).toBe(0)
  })
})

describe('cutTargetAt', () => {
  const clips = [clip('1', 0, 3), clip('2', 2, 5)]

  it('finds the clip the playhead is over', () => {
    expect(cutTargetAt(clips, 1.5, 30)?.clip.id).toBe('1')
    expect(cutTargetAt(clips, 4, 30)?.clip.id).toBe('2')
  })

  it('refuses a cut on a boundary that already exists', () => {
    // Cutting exactly where two clips meet would produce an empty clip.
    expect(cutTargetAt(clips, 0, 30)).toBeNull()
    expect(cutTargetAt(clips, 3, 30)).toBeNull()
  })

  it('refuses a cut that would leave an unusably short sliver', () => {
    // The same floor trimming works to: a cut is another way of setting an edge.
    expect(cutTargetAt(clips, MIN_CLIP_DURATION / 2, 30)).toBeNull()
    expect(cutTargetAt(clips, 3 - MIN_CLIP_DURATION / 2, 30)).toBeNull()
  })

  it('allows a cut exactly at the floor', () => {
    expect(cutTargetAt(clips, MIN_CLIP_DURATION, 30)?.clip.id).toBe('1')
  })

  it('refuses past the end and on an empty timeline', () => {
    expect(cutTargetAt(clips, 99, 30)).toBeNull()
    expect(cutTargetAt([], 1, 30)).toBeNull()
  })

  it('cuts where the picture actually is once it has been pushed back', () => {
    // The playhead is read in timeline time, so a lead-in has to move the
    // target with the picture — otherwise the cut lands somewhere else than
    // the frame line you parked on.
    expect(cutTargetAt(clips, 1.5, 30, 2)).toBeNull()
    expect(cutTargetAt(clips, 3.5, 30, 2)?.clip.id).toBe('1')
    expect(cutTargetAt(clips, 6, 30, 2)?.clip.id).toBe('2')
  })
})

describe('splitClipAt', () => {
  const clips = [clip('1', 2, 8)]
  const ids = () => {
    let count = 0
    return () => `new_${(count += 1)}`
  }

  it('leaves the two halves covering exactly what the one clip covered', () => {
    // The whole point: a cut changes where the edges are, never what plays.
    const result = splitClipAt(clips, 2, 30, ids())

    expect(result).not.toBeNull()
    expect(totalDuration(result!.clips)).toBeCloseTo(totalDuration(clips), 10)
    expect(result!.clips.map((entry) => [entry.inPoint, entry.outPoint])).toEqual([
      [2, 4],
      [4, 8],
    ])
  })

  it('snaps the cut to a frame rather than landing between two', () => {
    // 2.02s is most of the way through frame 60, so the cut belongs on 61 —
    // and the half in front of it has to be a whole number of frames long.
    const result = splitClipAt(clips, 2.02, 30, ids())

    expect(clipDuration(result!.clips[0]!) * 30).toBeCloseTo(61, 10)
    expect(result!.clips[0]?.outPoint).toBe(2 + snapToFrame(2.02, 30))
  })

  it('hands back the half that starts at the cut, which is what the playhead is over', () => {
    const result = splitClipAt(clips, 2, 30, ids())

    expect(result!.clipId).toBe('new_1')
    expect(result!.clips[1]?.id).toBe('new_1')
  })

  it('carries the clip’s sound settings onto both halves', () => {
    const muted = [{ ...clip('1', 0, 6), muted: true, volume: 0.4 }]

    const result = splitClipAt(muted, 3, 30, ids())

    expect(result!.clips.map(clipGain)).toEqual([0, 0])
    expect(result!.clips.every((entry) => entry.volume === 0.4)).toBe(true)
  })

  it('cuts the clip under the playhead, not the first one', () => {
    const result = splitClipAt([clip('1', 0, 3), clip('2', 0, 3)], 4, 30, ids())

    expect(result!.clips.map((entry) => entry.id)).toEqual(['1', '2', 'new_1'])
  })

  it('returns null where nothing can be cut, leaving the caller alone', () => {
    expect(splitClipAt(clips, 0, 30, ids())).toBeNull()
    expect(splitClipAt(clips, 99, 30, ids())).toBeNull()
  })

  it('does not mutate the clips it was given', () => {
    const original = [clip('1', 2, 8)]
    splitClipAt(original, 2, 30, ids())
    expect(original).toEqual([clip('1', 2, 8)])
  })

  it('leaves the right half a hard cut, even if the whole clip was dissolving', () => {
    // The transition belonged to what came before the original clip, and
    // stays with the left half — the right half meets the left at a fresh
    // boundary, not a dissolve.
    const dissolving = [clip('0', 0, 2), { ...clip('1', 2, 8), transitionIn: 1 }]
    const result = splitClipAt(dissolving, 5, 30, ids())

    expect(result!.clips[1]?.transitionIn).toBe(1)
    expect(result!.clips[2]?.transitionIn).toBeUndefined()
  })

  it('cuts at the right point in the source once the picture starts later', () => {
    // The playhead sits 2s into a clip that begins at 3s, so the boundary is
    // 2s into the source — not 5s, which is where it would land if the lead-in
    // were forgotten between finding the clip and splitting it.
    const result = splitClipAt(clips, 5, 30, ids(), 3)

    expect(result!.clips.map((entry) => [entry.inPoint, entry.outPoint])).toEqual([
      [2, 4],
      [4, 8],
    ])
  })
})

describe('isThroughCut', () => {
  it('recognises two halves of the same source meeting mid-clip', () => {
    expect(isThroughCut(clip('1', 0, 4), clip('2', 4, 9))).toBe(true)
  })

  it('does not mistake two separate clips for a cut', () => {
    expect(isThroughCut(clip('1', 0, 4), clip('2', 5, 9))).toBe(false)
    expect(isThroughCut(clip('1', 0, 4), clip('2', 4, 9, 'other'))).toBe(false)
  })
})

describe('joinCutAt', () => {
  it('puts a cut clip back exactly as it was', () => {
    const original = [clip('1', 1, 7)]
    const cut = splitClipAt(original, 2, 30, () => 'new_1')!

    const joined = joinCutAt(cut.clips, cut.clipId)

    expect(joined?.clips).toEqual(original)
    expect(joined?.clipId).toBe('1')
  })

  it('refuses to merge clips that are not the halves of a cut', () => {
    // Merging unrelated neighbours would silently throw one of them away.
    expect(joinCutAt([clip('1', 0, 4), clip('2', 6, 9)], '2')).toBeNull()
    expect(joinCutAt([clip('1', 0, 4), clip('2', 4, 9, 'other')], '2')).toBeNull()
  })

  it('refuses where there is no clip in front to join onto', () => {
    expect(joinCutAt([clip('1', 0, 4)], '1')).toBeNull()
    expect(joinCutAt([clip('1', 0, 4)], 'missing')).toBeNull()
  })

  it('does not mutate the clips it was given', () => {
    const clips = [clip('1', 0, 4), clip('2', 4, 9)]
    joinCutAt(clips, '2')
    expect(clips).toHaveLength(2)
  })
})

describe('clipGain', () => {
  it('plays a clip that says nothing about sound at full volume', () => {
    // Every clip authored before clips had sound looks like this, and they
    // must not all export silent.
    expect(clipGain(clip('1', 0, 3))).toBe(1)
  })

  it('silences a muted clip whatever its volume says', () => {
    expect(clipGain({ ...clip('1', 0, 3), muted: true, volume: 0.8 })).toBe(0)
  })

  it('takes the clip volume when it has one, including a boost', () => {
    expect(clipGain({ ...clip('1', 0, 3), volume: 0.25 })).toBe(0.25)
    expect(clipGain({ ...clip('1', 0, 3), volume: 1.5 })).toBe(1.5)
  })

  it('never returns a negative gain', () => {
    expect(clipGain({ ...clip('1', 0, 3), volume: -2 })).toBe(0)
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

describe('clipStartDeltas', () => {
  // 2s, 3s, 5s laid end to end: starts at 0, 2, 5.
  const clips = [clip('1', 0, 2), clip('2', 0, 3), clip('3', 0, 5)]

  it('reports how far each clip moved when one is dragged to the front', () => {
    const deltas = clipStartDeltas(clips, reorder(clips, 2, 0))
    // '3' leads now, so it moves back to 0 from 5; the other two follow it.
    expect(deltas.get('3')).toBeCloseTo(-5)
    expect(deltas.get('1')).toBeCloseTo(5)
    expect(deltas.get('2')).toBeCloseTo(5)
  })

  it('leaves out clips that did not move', () => {
    // Swapping the last two cannot disturb the first.
    const deltas = clipStartDeltas(clips, reorder(clips, 1, 2))
    expect(deltas.has('1')).toBe(false)
    expect(deltas.get('2')).toBeCloseTo(5)
    expect(deltas.get('3')).toBeCloseTo(-3)
  })

  it('is empty when the arrangement is unchanged', () => {
    expect(clipStartDeltas(clips, [...clips]).size).toBe(0)
  })

  it('measures against the lead-in, which shifts both sides alike', () => {
    const deltas = clipStartDeltas(clips, reorder(clips, 2, 0), 4)
    expect(deltas.get('3')).toBeCloseTo(-5)
    expect(deltas.get('1')).toBeCloseTo(5)
  })

  it('ignores clips missing from either arrangement', () => {
    const added = clip('4', 0, 1)
    // '4' has no previous position, and '1' — dropped here — has no new one.
    const deltas = clipStartDeltas(clips, [clips[1]!, clips[2]!, added])
    expect(deltas.has('4')).toBe(false)
    expect(deltas.has('1')).toBe(false)
    expect(deltas.get('2')).toBeCloseTo(-2)
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

  it('counts the lead-in, since the export has to render it', () => {
    expect(projectDuration({ ...base, leadIn: 3 })).toBe(6)
  })

  it('does not extend past audio that fits inside the lead-in', () => {
    // The beeps run 0–3s and the picture 3–6s: the project is still 6s long.
    const withCountIn: Project = {
      ...base,
      leadIn: 3,
      audioClips: [
        {
          id: 'beeps',
          trackId: 'c',
          assetId: 'a',
          useConverted: false,
          startTime: 0,
          inPoint: 0,
          duration: 3,
        },
      ],
    }
    expect(projectDuration(withCountIn)).toBe(6)
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

describe('formatTimecode', () => {
  it('counts frames after the seconds, not tenths of a second', () => {
    expect(formatTimecode(0, 30)).toBe('0:00:00')
    expect(formatTimecode(1, 30)).toBe('0:01:00')
    expect(formatTimecode(1.5, 30)).toBe('0:01:15')
    expect(formatTimecode(73.8, 30)).toBe('1:13:24')
  })

  it('counts in the project’s own rate', () => {
    // Half a second is twelve frames at 24 and thirty at 60. A readout that
    // said "15" either way would be naming a frame that does not exist.
    expect(formatTimecode(0.5, 24)).toBe('0:00:12')
    expect(formatTimecode(0.5, 60)).toBe('0:00:30')
  })

  it('never shows a frame the rate does not have', () => {
    // The failure this guards: rounding the seconds and the frame apart, and
    // arriving at 0:00:30 on a thirty-frame second, which has 0 to 29.
    for (let frame = 0; frame <= 60; frame += 1) {
      const shown = formatTimecode(frame / 30 + 1e-9, 30)
      expect(Number(shown.split(':')[2])).toBeLessThan(30)
    }
    expect(formatTimecode(0.9999, 30)).toBe('0:01:00')
  })

  it('rolls over into minutes', () => {
    expect(formatTimecode(59.999, 30)).toBe('1:00:00')
    expect(formatTimecode(600, 30)).toBe('10:00:00')
  })

  it('does not blow up on nonsense input', () => {
    expect(formatTimecode(Number.NaN, 30)).toBe('0:00:00')
    expect(formatTimecode(-4, 30)).toBe('0:00:00')
    expect(formatTimecode(1, 0)).toBe('0:01:00')
  })
})

describe('stepFrames', () => {
  it('moves exactly one frame', () => {
    expect(stepFrames(0, 1, 30)).toBeCloseTo(1 / 30, 10)
    expect(stepFrames(1, -1, 30)).toBeCloseTo(29 / 30, 10)
  })

  it('lands on a frame boundary from anywhere between two', () => {
    // Arrow keys are how you park the playhead where a cut can go, so a step
    // has to leave it somewhere a cut is allowed.
    const landed = stepFrames(0.4321, 1, 30)
    expect(landed).toBeCloseTo(snapToFrame(landed, 30), 10)
  })

  it('does not drift over many presses, which adding 1/30 would', () => {
    let time = 0
    for (let press = 0; press < 300; press += 1) time = stepFrames(time, 1, 30)
    expect(time).toBeCloseTo(10, 9)
  })

  it('stops at the top rather than going negative', () => {
    expect(stepFrames(1 / 30, -5, 30)).toBe(0)
  })

  it('steps a second at a time when asked for a rate’s worth', () => {
    expect(stepFrames(2, 30, 30)).toBeCloseTo(3, 10)
    expect(stepFrames(2, -24, 24)).toBeCloseTo(1, 10)
  })
})
