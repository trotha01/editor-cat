import { describe, expect, it } from 'vitest'
import {
  audibleClipsAt,
  audioCutTargetAt,
  audioEnd,
  createTrack,
  defaultTracks,
  findTrackWithRoom,
  gainFor,
  insertTrack,
  migrateProject,
  moveAudioClip,
  nextTrackName,
  retypeTrack,
  placeAudioClip,
  rangesOverlap,
  splitAudioClipAt,
  trackHasRoom,
} from './audioTracks'
import type { AudioClip, AudioTrack, AudioTrackKind, Project } from './types'

const track = (
  id: string,
  kind: AudioTrackKind = 'voice',
  extra: Partial<AudioTrack> = {},
): AudioTrack => ({
  id,
  kind,
  name: id,
  muted: false,
  volume: 1,
  ...extra,
})

const clip = (id: string, trackId: string, startTime: number, duration: number): AudioClip => ({
  id,
  trackId,
  assetId: `asset-${id}`,
  useConverted: false,
  startTime,
  inPoint: 0,
  duration,
})

/** Deterministic id generator, so assertions can name the ids they expect. */
function idFactory() {
  let n = 0
  return (prefix: string) => `${prefix}-${++n}`
}

describe('rangesOverlap', () => {
  it('detects a genuine overlap', () => {
    expect(rangesOverlap({ startTime: 0, duration: 2 }, { startTime: 1, duration: 2 })).toBe(true)
  })

  it('treats clips that merely touch as not overlapping', () => {
    // Back-to-back takes are the normal case and must be allowed to share a
    // lane, so an end that equals the next start cannot count as a collision.
    expect(rangesOverlap({ startTime: 0, duration: 2 }, { startTime: 2, duration: 2 })).toBe(false)
  })

  it('is symmetric', () => {
    const a = { startTime: 0, duration: 5 }
    const b = { startTime: 3, duration: 1 }
    expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a))
  })

  it('ignores zero-length ranges', () => {
    expect(rangesOverlap({ startTime: 1, duration: 0 }, { startTime: 0, duration: 5 })).toBe(false)
  })
})

describe('trackHasRoom', () => {
  const clips = [clip('a', 't1', 0, 2)]

  it('finds a gap after an existing clip', () => {
    expect(trackHasRoom(clips, 't1', { startTime: 3, duration: 1 })).toBe(true)
  })

  it('refuses a slot that collides', () => {
    expect(trackHasRoom(clips, 't1', { startTime: 1, duration: 1 })).toBe(false)
  })

  it('only considers clips on the track being asked about', () => {
    expect(trackHasRoom(clips, 't2', { startTime: 0, duration: 2 })).toBe(true)
  })

  it('can ignore a clip being moved so it does not block itself', () => {
    expect(trackHasRoom(clips, 't1', { startTime: 0.5, duration: 2 }, 'a')).toBe(true)
  })
})

describe('findTrackWithRoom', () => {
  const tracks = [track('v1'), track('v2'), track('m1', 'music')]

  it('takes the first track with a free slot', () => {
    const clips = [clip('a', 'v1', 0, 5)]
    expect(findTrackWithRoom(tracks, clips, 'voice', { startTime: 1, duration: 1 })?.id).toBe('v2')
  })

  it('layers onto the earliest track when nothing is in the way', () => {
    expect(findTrackWithRoom(tracks, [], 'voice', { startTime: 0, duration: 1 })?.id).toBe('v1')
  })

  it('never puts a voice take on a music track', () => {
    // Music tracks run at a lower gain, so a take landing there would be
    // quietly ducked under the score it was meant to sit above.
    const clips = [clip('a', 'v1', 0, 5), clip('b', 'v2', 0, 5)]
    expect(findTrackWithRoom(tracks, clips, 'voice', { startTime: 1, duration: 1 })).toBeNull()
  })

  it('returns null when every track of that kind is busy', () => {
    const clips = [clip('a', 'v1', 0, 5), clip('b', 'v2', 0, 5)]
    expect(findTrackWithRoom(tracks, clips, 'voice', { startTime: 0, duration: 2 })).toBeNull()
  })
})

describe('placeAudioClip', () => {
  const newClip = (id: string, startTime: number, duration: number) => ({
    id,
    assetId: `asset-${id}`,
    useConverted: false,
    startTime,
    inPoint: 0,
    duration,
  })

  it('layers a second take onto an existing free track', () => {
    const tracks = [track('v1'), track('v2')]
    const clips = [clip('a', 'v1', 0, 5)]

    const result = placeAudioClip(tracks, clips, {
      kind: 'voice',
      newTrackId: 'should-not-be-used',
      clip: newClip('b', 1, 2),
    })

    expect(result.createdTrack).toBe(false)
    expect(result.trackId).toBe('v2')
    expect(result.tracks).toHaveLength(2)
    expect(result.clips).toHaveLength(2)
  })

  it('reuses the same track when the new take does not collide', () => {
    const tracks = [track('v1')]
    const clips = [clip('a', 'v1', 0, 2)]

    const result = placeAudioClip(tracks, clips, {
      kind: 'voice',
      newTrackId: 'unused',
      clip: newClip('b', 5, 2),
    })

    expect(result.trackId).toBe('v1')
    expect(result.createdTrack).toBe(false)
  })

  it('creates a new track when every existing one is full at that moment', () => {
    const tracks = [track('v1'), track('v2')]
    const clips = [clip('a', 'v1', 0, 5), clip('b', 'v2', 0, 5)]

    const result = placeAudioClip(tracks, clips, {
      kind: 'voice',
      newTrackId: 'v3',
      clip: newClip('c', 1, 2),
    })

    expect(result.createdTrack).toBe(true)
    expect(result.trackId).toBe('v3')
    expect(result.tracks).toHaveLength(3)
    expect(result.tracks.find((t) => t.id === 'v3')?.name).toBe('Voice 1')
  })

  it('creates the first track when the project has none', () => {
    const result = placeAudioClip([], [], {
      kind: 'music',
      newTrackId: 'm1',
      clip: newClip('a', 0, 10),
    })

    expect(result.createdTrack).toBe(true)
    expect(result.tracks[0]).toMatchObject({ id: 'm1', kind: 'music' })
  })

  it('gives the count-in a lane of its own rather than any existing one', () => {
    // Beeps dropped onto a voice lane would be at the mercy of the takes around
    // them: a drag onto an occupied stretch is refused, so a cue could not be
    // nudged to the exact spot it has to hit.
    const tracks = [track('v1'), track('m1', 'music')]

    const result = placeAudioClip(tracks, [], {
      kind: 'countdown',
      newTrackId: 'c1',
      clip: newClip('beeps', 4, 3),
    })

    expect(result.createdTrack).toBe(true)
    expect(result.tracks.find((entry) => entry.id === 'c1')).toMatchObject({
      kind: 'countdown',
      name: 'Countdown 1',
    })
    expect(result.clips[0]?.trackId).toBe('c1')
  })

  it('reuses the countdown lane for a second count-in that fits', () => {
    const tracks = [track('c1', 'countdown')]
    const clips = [clip('beeps', 'c1', 0, 3)]

    const result = placeAudioClip(tracks, clips, {
      kind: 'countdown',
      newTrackId: 'unused',
      clip: newClip('beeps2', 10, 3),
    })

    expect(result.trackId).toBe('c1')
    expect(result.createdTrack).toBe(false)
  })

  it('does not mutate the arrays it was given', () => {
    const tracks = [track('v1')]
    const clips = [clip('a', 'v1', 0, 5)]

    placeAudioClip(tracks, clips, { kind: 'voice', newTrackId: 'v2', clip: newClip('b', 0, 1) })

    expect(tracks).toHaveLength(1)
    expect(clips).toHaveLength(1)
  })

  it('stacks a third lane when two are already occupied at that time', () => {
    let tracks: AudioTrack[] = [track('v1')]
    let clips: AudioClip[] = []

    for (const id of ['a', 'b', 'c']) {
      const result = placeAudioClip(tracks, clips, {
        kind: 'voice',
        newTrackId: `new-${id}`,
        clip: newClip(id, 0, 3),
      })
      tracks = result.tracks
      clips = result.clips
    }

    // Three overlapping takes cannot share fewer than three lanes.
    expect(new Set(clips.map((entry) => entry.trackId)).size).toBe(3)
    expect(tracks).toHaveLength(3)
  })
})

describe('moveAudioClip', () => {
  const clips = [clip('a', 't1', 0, 2), clip('b', 't2', 0, 2)]

  it('retimes a clip on its own track', () => {
    const result = moveAudioClip(clips, 'a', { startTime: 5 })
    expect(result.moved).toBe(true)
    expect(result.clips.find((entry) => entry.id === 'a')?.startTime).toBe(5)
  })

  it('moves a clip to another track', () => {
    const result = moveAudioClip(clips, 'a', { startTime: 5, trackId: 't2' })
    expect(result.moved).toBe(true)
    expect(result.clips.find((entry) => entry.id === 'a')?.trackId).toBe('t2')
  })

  it('refuses a move that would land on top of another clip', () => {
    // Silently allowing the overlap would produce a mix the timeline does not
    // depict, and the user would only discover it on export.
    const result = moveAudioClip(clips, 'a', { startTime: 1, trackId: 't2' })
    expect(result.moved).toBe(false)
    expect(result.clips.find((entry) => entry.id === 'a')?.trackId).toBe('t1')
  })

  it('never moves a clip before zero', () => {
    const result = moveAudioClip(clips, 'a', { startTime: -10 })
    expect(result.clips.find((entry) => entry.id === 'a')?.startTime).toBe(0)
  })

  it('is a no-op for an unknown clip', () => {
    expect(moveAudioClip(clips, 'missing', { startTime: 1 }).moved).toBe(false)
  })

  it('slides a count-in freely under the takes it counts into', () => {
    // The whole reason the beeps get their own lane: wherever the takes are,
    // the cue can be parked to the exact frame it has to lead into.
    const withCountdown = [clip('take', 'v1', 5, 10), clip('beeps', 'c1', 0, 3)]
    const result = moveAudioClip(withCountdown, 'beeps', { startTime: 2 })

    expect(result.moved).toBe(true)
    expect(result.clips.find((entry) => entry.id === 'beeps')?.startTime).toBe(2)
  })
})

describe('splitAudioClipAt', () => {
  const clips = [clip('a', 't1', 4, 10)]

  it('cuts a clip into two halves that cover what the one clip covered', () => {
    const result = splitAudioClipAt(clips, 'a', 7, () => 'new')

    expect(result?.clips.map((entry) => [entry.id, entry.startTime, entry.duration])).toEqual([
      ['a', 4, 3],
      ['new', 7, 7],
    ])
  })

  it('carries the source forward, so the halves still play what the clip played', () => {
    const sourced = [{ ...clip('a', 't1', 4, 10), inPoint: 30 }]
    const result = splitAudioClipAt(sourced, 'a', 7, () => 'new')

    // The second half starts three seconds further into the same file, which is
    // exactly the three seconds the first half now plays.
    expect(result?.clips[1]?.inPoint).toBe(33)
    expect(result?.clips[1]?.assetId).toBe(result?.clips[0]?.assetId)
    expect(result?.clips[1]?.trackId).toBe('t1')
  })

  it('keeps both halves anchored to the shot the clip was performed against', () => {
    // Re-anchoring the second half to whatever shot it now starts over would let
    // the two be pulled apart — and land on top of each other — the next time
    // either shot moved.
    const anchored = [{ ...clip('a', 't1', 4, 10), anchorClipId: 'shot-1' }]
    const result = splitAudioClipAt(anchored, 'a', 7, () => 'new')

    expect(result?.clips.map((entry) => entry.anchorClipId)).toEqual(['shot-1', 'shot-1'])
  })

  it('selects the half after the cut', () => {
    expect(splitAudioClipAt(clips, 'a', 7, () => 'new')?.clipId).toBe('new')
  })

  it('leaves the other clips alone, in place', () => {
    const two = [clip('a', 't1', 4, 10), clip('b', 't2', 0, 30)]
    const result = splitAudioClipAt(two, 'a', 7, () => 'new')

    expect(result?.clips.map((entry) => entry.id)).toEqual(['a', 'new', 'b'])
  })

  it('refuses a cut on the clip’s own edges, which would leave nothing behind', () => {
    expect(splitAudioClipAt(clips, 'a', 4, () => 'new')).toBeNull()
    expect(splitAudioClipAt(clips, 'a', 14, () => 'new')).toBeNull()
  })

  it('refuses a cut outside the clip entirely', () => {
    expect(splitAudioClipAt(clips, 'a', 1, () => 'new')).toBeNull()
    expect(splitAudioClipAt(clips, 'a', 20, () => 'new')).toBeNull()
  })

  it('refuses a cut that would leave a sliver', () => {
    expect(splitAudioClipAt(clips, 'a', 4.01, () => 'new')).toBeNull()
    expect(splitAudioClipAt(clips, 'a', 13.99, () => 'new')).toBeNull()
  })

  it('is a no-op for an unknown clip', () => {
    expect(splitAudioClipAt(clips, 'missing', 7, () => 'new')).toBeNull()
  })

  it('never mutates the clips it was given', () => {
    const original = [clip('a', 't1', 4, 10)]
    splitAudioClipAt(original, 'a', 7, () => 'new')
    expect(original).toEqual([clip('a', 't1', 4, 10)])
  })
})

describe('audioCutTargetAt', () => {
  const clips = [clip('a', 't1', 4, 10), clip('b', 't2', 0, 30)]

  it('answers with the named clip when a cut can land in it', () => {
    expect(audioCutTargetAt(clips, 'a', 7)?.id).toBe('a')
  })

  it('answers with nothing when no clip is named', () => {
    // What stops the button cutting whatever the playhead happens to cross.
    expect(audioCutTargetAt(clips, null, 7)).toBeNull()
  })

  it('answers with nothing when the playhead is outside the named clip', () => {
    expect(audioCutTargetAt(clips, 'a', 2)).toBeNull()
  })
})

describe('nextTrackName', () => {
  it('numbers each kind independently', () => {
    const tracks = [
      track('a', 'voice', { name: 'Voice 1' }),
      track('b', 'voice', { name: 'Voice 2' }),
      track('c', 'music', { name: 'Music 1' }),
    ]
    expect(nextTrackName(tracks, 'voice')).toBe('Voice 3')
    expect(nextTrackName(tracks, 'music')).toBe('Music 2')
    expect(nextTrackName(tracks, 'countdown')).toBe('Countdown 1')
  })

  it('reuses a number freed by deleting a track', () => {
    const tracks = [track('a', 'voice', { name: 'Voice 2' })]
    expect(nextTrackName(tracks, 'voice')).toBe('Voice 1')
  })

  it('skips names already taken rather than duplicating one', () => {
    const tracks = [
      track('a', 'voice', { name: 'Voice 1' }),
      track('b', 'voice', { name: 'Voice 3' }),
    ]
    expect(nextTrackName(tracks, 'voice')).toBe('Voice 2')
  })
})

describe('createTrack', () => {
  it('starts music quieter than voice, so a score sits under narration', () => {
    expect(createTrack('m', 'music', []).volume).toBeLessThan(createTrack('v', 'voice', []).volume)
  })

  it('starts unmuted', () => {
    expect(createTrack('v', 'voice', []).muted).toBe(false)
  })

  it('does not duck the count-in the way it ducks music', () => {
    // A cue you have to strain to hear is no use to perform to.
    expect(createTrack('c', 'countdown', []).volume).toBe(createTrack('v', 'voice', []).volume)
  })
})

describe('insertTrack', () => {
  it('groups a new track with others of its kind rather than appending', () => {
    const tracks = [track('v1'), track('m1', 'music')]
    const next = insertTrack(tracks, track('v2'))
    expect(next.map((entry) => entry.id)).toEqual(['v1', 'v2', 'm1'])
  })

  it('appends when there is nothing of that kind yet', () => {
    const next = insertTrack([track('v1')], track('m1', 'music'))
    expect(next.map((entry) => entry.id)).toEqual(['v1', 'm1'])
  })
})

describe('retypeTrack', () => {
  it('changes what a lane carries', () => {
    const next = retypeTrack([track('t1')], 't1', 'music')
    expect(next[0]?.kind).toBe('music')
  })

  it('moves the lane in among its new kind', () => {
    // Where a lane sits is what says what it is, so a lane that changes kind
    // and stays put would leave the grouping lying.
    //
    // The retyped lane has to land in the *middle* for this to test anything:
    // pick a case where it ends up last and simply appending it passes too.
    const tracks = [track('v1'), track('m1', 'music'), track('m2', 'music')]
    const next = retypeTrack(tracks, 'm2', 'voice')

    expect(next.map((entry) => entry.id)).toEqual(['v1', 'm2', 'm1'])
  })

  it('renames a lane that still has the name it was given', () => {
    const tracks = [
      track('a', 'voice', { name: 'Voice 1' }),
      track('b', 'music', { name: 'Music 1' }),
    ]
    expect(retypeTrack(tracks, 'a', 'music').find((entry) => entry.id === 'a')?.name).toBe(
      'Music 2',
    )
  })

  it('keeps a name someone chose themselves', () => {
    const tracks = [track('a', 'voice', { name: 'Narrator' })]
    expect(retypeTrack(tracks, 'a', 'music')[0]?.name).toBe('Narrator')
  })

  it('leaves the level alone, because it may have been set by hand', () => {
    // Pulling a balanced bed down to the music default would undo work rather
    // than finish a rename.
    const tracks = [track('a', 'voice', { volume: 0.35 })]
    expect(retypeTrack(tracks, 'a', 'music')[0]?.volume).toBe(0.35)
  })

  it('keeps the clips where they are, since they belong to the lane', () => {
    const tracks = [track('a'), track('b', 'music')]
    const next = retypeTrack(tracks, 'a', 'music')
    expect(next.map((entry) => entry.id).sort()).toEqual(['a', 'b'])
    expect(next).toHaveLength(2)
  })

  it('does nothing for a kind it already is, or a lane that is not there', () => {
    const tracks = [track('a')]
    expect(retypeTrack(tracks, 'a', 'voice')).toEqual(tracks)
    expect(retypeTrack(tracks, 'nope', 'music')).toEqual(tracks)
  })

  it('never mutates what it was given', () => {
    const tracks = [track('a')]
    retypeTrack(tracks, 'a', 'music')
    expect(tracks[0]?.kind).toBe('voice')
  })
})

describe('gainFor', () => {
  const tracks = [track('t1', 'voice', { volume: 0.8 }), track('t2', 'voice', { muted: true })]

  it('reports the track volume', () => {
    expect(gainFor(tracks, clip('a', 't1', 0, 1))).toBe(0.8)
  })

  it('reports zero for a muted track', () => {
    expect(gainFor(tracks, clip('a', 't2', 0, 1))).toBe(0)
  })

  it('reports zero for a clip whose track has gone', () => {
    // Defaulting to unity would make deleting a track louder, not quieter.
    expect(gainFor(tracks, clip('a', 'gone', 0, 1))).toBe(0)
  })
})

describe('audibleClipsAt', () => {
  const tracks = [track('t1'), track('t2', 'voice', { muted: true })]
  const clips = [clip('a', 't1', 0, 3), clip('b', 't2', 0, 3)]

  it('returns overlapping clips on unmuted tracks only', () => {
    expect(audibleClipsAt(tracks, clips, 1).map((entry) => entry.id)).toEqual(['a'])
  })

  it('returns nothing past the end', () => {
    expect(audibleClipsAt(tracks, clips, 9)).toEqual([])
  })
})

describe('audioEnd', () => {
  it('reports when the last clip finishes', () => {
    expect(audioEnd([clip('a', 't', 0, 2), clip('b', 't', 5, 3)])).toBe(8)
  })

  it('is zero with no clips', () => {
    expect(audioEnd([])).toBe(0)
  })
})

describe('defaultTracks', () => {
  it('seeds one voice and one music lane', () => {
    const tracks = defaultTracks('v', 'm')
    expect(tracks.map((entry) => entry.kind)).toEqual(['voice', 'music'])
  })
})

describe('migrateProject', () => {
  const legacyBase = {
    id: 'p',
    name: 'p',
    clips: [],
    width: 1280,
    height: 720,
    fps: 30,
  }

  it('moves flat voiceovers onto tracks', () => {
    const legacy = {
      ...legacyBase,
      voiceovers: [
        { id: 'v1', assetId: 'a1', useConverted: false, startTime: 0, duration: 2 },
        { id: 'v2', assetId: 'a2', useConverted: false, startTime: 5, duration: 2 },
      ],
    } as unknown as Project

    const migrated = migrateProject(legacy, idFactory())

    expect(migrated.audioClips).toHaveLength(2)
    expect(migrated.voiceovers).toBeUndefined()
    // Neither take overlaps, so both fit on the seeded voice lane.
    expect(new Set(migrated.audioClips.map((clip) => clip.trackId)).size).toBe(1)
  })

  it('separates legacy takes that overlapped onto different tracks', () => {
    // Before multitrack these fought each other on one lane; migration is the
    // right moment to give them the layers they always needed.
    const legacy = {
      ...legacyBase,
      voiceovers: [
        { id: 'v1', assetId: 'a1', useConverted: false, startTime: 0, duration: 5 },
        { id: 'v2', assetId: 'a2', useConverted: false, startTime: 1, duration: 5 },
      ],
    } as unknown as Project

    const migrated = migrateProject(legacy, idFactory())
    expect(new Set(migrated.audioClips.map((clip) => clip.trackId)).size).toBe(2)
  })

  it('carries a conversion across', () => {
    const legacy = {
      ...legacyBase,
      voiceovers: [
        {
          id: 'v1',
          assetId: 'a1',
          convertedAssetId: 'a2',
          useConverted: true,
          startTime: 0,
          duration: 2,
          voiceName: 'Rachel',
        },
      ],
    } as unknown as Project

    const migrated = migrateProject(legacy, idFactory())
    expect(migrated.audioClips[0]).toMatchObject({
      convertedAssetId: 'a2',
      useConverted: true,
      voiceName: 'Rachel',
      inPoint: 0,
    })
  })

  it('seeds tracks for a legacy project with no voiceovers at all', () => {
    const migrated = migrateProject(
      { ...legacyBase, voiceovers: [] } as unknown as Project,
      idFactory(),
    )
    expect(migrated.audioTracks.length).toBeGreaterThan(0)
    expect(migrated.audioClips).toEqual([])
  })

  it('leaves an already-migrated project untouched', () => {
    const modern: Project = {
      ...legacyBase,
      audioTracks: [track('t1')],
      audioClips: [clip('a', 't1', 0, 2)],
    }
    expect(migrateProject(modern, idFactory())).toBe(modern)
  })
})
