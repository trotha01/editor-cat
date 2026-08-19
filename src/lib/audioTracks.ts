/**
 * Multitrack audio: where a new clip goes, and how tracks are created.
 *
 * All of this is pure. Track assignment is the part most likely to go subtly
 * wrong — a clip landing on top of an existing one silently ruins a mix, and
 * you would only notice on export — so it lives here, free of React and IO,
 * and is tested directly.
 *
 * The placement rule is first-fit: try each track of the right kind in order
 * and take the first one with a free gap at that time. Only if every track is
 * busy do we add a new one. That gives the behaviour you want from a recorder —
 * layer onto what exists where there is room, stack a new lane when there is
 * not — without ever asking the user to think about tracks.
 */
import {
  clipEnd,
  clipsOnTrack as clipsOnLane,
  laneWithRoom,
  lanesEnd,
  moveClipInLane,
  trackHasRoom as laneHasRoom,
  type TimeRange,
} from './lanes'
import type {
  AudioClip,
  AudioTrack,
  AudioTrackKind,
  LegacyVoiceoverTake,
  PositionedClip,
  Project,
} from './types'

// The lane arithmetic is shared with the video tracks, which work the same way.
// Re-exported here so the audio side still reads as one module.
export { clipEnd, rangesOverlap, type TimeRange } from './lanes'

/**
 * Unity gain for narration; score sits under it by default. Cues are left at
 * unity too — a count-in you have to strain to hear is no use to play to, and
 * the beeps are synthesised short of full scale so there is room for them.
 */
const DEFAULT_VOLUME: Record<AudioTrackKind, number> = {
  voice: 1,
  music: 0.5,
  countdown: 1,
}

const TRACK_LABEL: Record<AudioTrackKind, string> = {
  voice: 'Voice',
  music: 'Music',
  countdown: 'Countdown',
}

export function clipsOnTrack(clips: readonly AudioClip[], trackId: string): AudioClip[] {
  return clipsOnLane(clips, trackId)
}

/**
 * Whether `range` fits on a track without colliding.
 * `ignoreClipId` lets a clip be tested against its own track while being moved.
 */
export function trackHasRoom(
  clips: readonly AudioClip[],
  trackId: string,
  range: TimeRange,
  ignoreClipId?: string,
): boolean {
  return laneHasRoom(clips, trackId, range, ignoreClipId)
}

/**
 * The first track of `kind` with room for `range`, or null if they are all
 * busy at that moment and a new track is needed.
 */
export function findTrackWithRoom(
  tracks: readonly AudioTrack[],
  clips: readonly AudioClip[],
  kind: AudioTrackKind,
  range: TimeRange,
): AudioTrack | null {
  return laneWithRoom(tracks, clips, range, (track) => track.kind === kind)
}

/** Names new tracks "Voice 1", "Voice 2", … counting only that kind. */
export function nextTrackName(tracks: readonly AudioTrack[], kind: AudioTrackKind): string {
  const label = TRACK_LABEL[kind]
  const used = new Set(tracks.filter((track) => track.kind === kind).map((track) => track.name))
  for (let index = 1; ; index += 1) {
    const candidate = `${label} ${index}`
    if (!used.has(candidate)) return candidate
  }
}

export function createTrack(
  id: string,
  kind: AudioTrackKind,
  tracks: readonly AudioTrack[],
): AudioTrack {
  return {
    id,
    kind,
    name: nextTrackName(tracks, kind),
    muted: false,
    volume: DEFAULT_VOLUME[kind],
  }
}

/**
 * Inserts a track next to the others of its kind rather than at the end, so
 * voice lanes stay grouped together above the music bed as they accumulate.
 */
export function insertTrack(tracks: readonly AudioTrack[], track: AudioTrack): AudioTrack[] {
  const next = [...tracks]
  let lastOfKind = -1
  next.forEach((entry, index) => {
    if (entry.kind === track.kind) lastOfKind = index
  })
  if (lastOfKind === -1) next.push(track)
  else next.splice(lastOfKind + 1, 0, track)
  return next
}

/**
 * Changes what a lane is for, and moves it in among its new kind.
 *
 * A lane is added without being asked what it is going to carry, so this is how
 * it gets told afterwards. Three things follow from the kind and all three have
 * to follow the change: what the lane is called, where it sits among the others,
 * and which lanes its clips can be dragged to — that last one being the reason a
 * mislabelled lane is worth more than a cosmetic annoyance.
 *
 * The level is deliberately not reset. It is the one property the user may have
 * set by hand, and silently pulling a bed down to half after they balanced it
 * would undo work rather than complete a rename.
 */
export function retypeTrack(
  tracks: readonly AudioTrack[],
  trackId: string,
  kind: AudioTrackKind,
): AudioTrack[] {
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track || track.kind === kind) return [...tracks]

  const others = tracks.filter((entry) => entry.id !== trackId)
  const renamed = {
    ...track,
    kind,
    // Only auto-generated names are replaced. Someone who has named a lane
    // meant that name, and it does not stop being theirs on a change of kind.
    name: isDefaultName(track.name) ? nextTrackName(others, kind) : track.name,
  }
  return insertTrack(others, renamed)
}

/** True for the "Voice 1"/"Music 3" names `nextTrackName` hands out. */
function isDefaultName(name: string): boolean {
  return Object.values(TRACK_LABEL).some((label) => new RegExp(`^${label} \\d+$`).test(name))
}

export interface PlacementRequest {
  kind: AudioTrackKind
  clip: Omit<AudioClip, 'trackId'>
  /** Ids for anything that has to be created. Passed in to keep this pure. */
  newTrackId: string
}

export interface PlacementResult {
  tracks: AudioTrack[]
  clips: AudioClip[]
  /** The track the clip ended up on. */
  trackId: string
  /** True when every existing track was busy and a lane had to be added. */
  createdTrack: boolean
}

/**
 * Places a clip, adding a track only when there is nowhere for it to go.
 * Returns new arrays; never mutates its inputs.
 */
export function placeAudioClip(
  tracks: readonly AudioTrack[],
  clips: readonly AudioClip[],
  { kind, clip, newTrackId }: PlacementRequest,
): PlacementResult {
  const existing = findTrackWithRoom(tracks, clips, kind, clip)

  if (existing) {
    return {
      tracks: [...tracks],
      clips: [...clips, { ...clip, trackId: existing.id }],
      trackId: existing.id,
      createdTrack: false,
    }
  }

  const track = createTrack(newTrackId, kind, tracks)
  return {
    tracks: insertTrack(tracks, track),
    clips: [...clips, { ...clip, trackId: track.id }],
    trackId: track.id,
    createdTrack: true,
  }
}

/**
 * Shortest piece a cut may leave behind.
 *
 * Well under the picture's own floor, and deliberately so: audio has no frames
 * to land between, and a fifth of a second is a whole drum hit — a length
 * somebody cutting a music bed to picture has every reason to want. This is only
 * here to stop a mis-aimed cut leaving a sliver too small to see or to grab.
 */
export const MIN_AUDIO_CLIP_DURATION = 0.05

/**
 * The clip a cut at `time` would fall in, or null when there is nothing to cut
 * there.
 *
 * Only ever the clip that is *asked* for, rather than whatever happens to be
 * under the playhead. Several lanes are usually sounding at once, and cutting
 * all of them because the playhead crosses them is an edit nobody asked for —
 * so the caller names the clip, which in the app is the selected one.
 */
export function audioCutTargetAt(
  clips: readonly AudioClip[],
  clipId: string | null | undefined,
  time: number,
): AudioClip | null {
  if (!clipId) return null
  const clip = clips.find((entry) => entry.id === clipId)
  if (!clip) return null
  const offset = time - clip.startTime
  // Strictly inside, with room left on both sides: a cut on a clip's own edge is
  // one that already exists there, and would otherwise leave an empty clip.
  if (offset < MIN_AUDIO_CLIP_DURATION) return null
  if (clip.duration - offset < MIN_AUDIO_CLIP_DURATION) return null
  return clip
}

/**
 * Every clip a cut at `time` would fall inside, across every track.
 *
 * Where `audioCutTargetAt` answers for the one clip a caller names,
 * this is for when nothing was named at all: a bare Cut with no selection
 * takes whatever is sounding under the playhead, on every lane, the same way
 * the picture always has.
 */
export function audioCutTargetsAt(clips: readonly AudioClip[], time: number): AudioClip[] {
  return clips.filter((clip) => audioCutTargetAt(clips, clip.id, time) !== null)
}

export interface AudioCutResult {
  clips: AudioClip[]
  /**
   * The half after the cut, which is a new clip. Selected afterwards, so a
   * second cut — or a delete — lands on the piece the playhead is now over.
   */
  clipId: string
}

/**
 * Cuts one audio clip in two at `time`.
 *
 * Both halves keep pointing at the same source and together they cover exactly
 * what the one clip covered, so a cut changes nothing about what is heard until
 * one of the halves is moved, deleted or levelled. Returns null when there is
 * nothing cuttable there, leaving the caller's clips alone.
 *
 * The anchor is carried onto both halves rather than recomputed for the half
 * behind the cut. Two halves anchored to different shots would be pulled apart
 * the moment either shot moved — and a cut that can silently turn into an
 * overlap is worse than one that keeps a take whole where it was performed.
 *
 * Unsnapped: audio has no frames, and the caller is free to snap the playhead
 * first — which the app does, so a cut through the picture and a cut through the
 * sound under it land on the same instant.
 *
 * `makeId` is injected so this stays pure and testable.
 */
export function splitAudioClipAt(
  clips: readonly AudioClip[],
  clipId: string,
  time: number,
  makeId: () => string,
): AudioCutResult | null {
  const target = audioCutTargetAt(clips, clipId, time)
  if (!target) return null

  const offset = time - target.startTime
  const left: AudioClip = { ...target, duration: offset }
  const right: AudioClip = {
    ...target,
    id: makeId(),
    startTime: target.startTime + offset,
    inPoint: target.inPoint + offset,
    duration: target.duration - offset,
  }

  const index = clips.findIndex((entry) => entry.id === clipId)
  const next = [...clips]
  next.splice(index, 1, left, right)
  return { clips: next, clipId: right.id }
}

export interface AudioCutAllResult {
  clips: AudioClip[]
  /** The half behind the cut on each clip that got one. */
  clipIds: string[]
}

/**
 * Cuts every clip at `time` that has one to make, across every track — what a
 * bare Cut means with nothing selected: not one clip in particular, so every
 * lane sounding there gets the same cut the picture does. Returns null when
 * there was nothing cuttable anywhere.
 *
 * Each clip is cut independently, so one going through never changes whether
 * or where another one can.
 */
export function splitAudioClipsAt(
  clips: readonly AudioClip[],
  time: number,
  makeId: () => string,
): AudioCutAllResult | null {
  const targets = audioCutTargetsAt(clips, time)
  if (targets.length === 0) return null

  let next: AudioClip[] = [...clips]
  const clipIds: string[] = []
  for (const target of targets) {
    const result = splitAudioClipAt(next, target.id, time, makeId)
    if (!result) continue
    next = result.clips
    clipIds.push(result.clipId)
  }
  return { clips: next, clipIds }
}

/**
 * Moves a clip in time and optionally to another track, refusing the move if
 * it would land on top of something. Returns the clips unchanged when blocked,
 * so a bad drag is a no-op rather than a silent overlap.
 */
export function moveAudioClip(
  clips: readonly AudioClip[],
  clipId: string,
  next: { startTime: number; trackId?: string },
): { clips: AudioClip[]; moved: boolean } {
  return moveClipInLane(clips, clipId, next)
}

/** When the last audio finishes, in seconds. */
export function audioEnd(clips: readonly AudioClip[]): number {
  return lanesEnd(clips)
}

/** Clips audible at time `t`, ignoring muted tracks. */
export function audibleClipsAt(
  tracks: readonly AudioTrack[],
  clips: readonly AudioClip[],
  t: number,
): AudioClip[] {
  const muted = new Set(tracks.filter((track) => track.muted).map((track) => track.id))
  return clips.filter(
    (clip) => !muted.has(clip.trackId) && t >= clip.startTime && t < clipEnd(clip),
  )
}

/**
 * Effective gain for a clip, or 0 if its track is muted or missing.
 *
 * A clip whose track has been deleted must be silent rather than defaulting to
 * full volume — otherwise deleting a track would make it louder.
 */
export function gainFor(tracks: readonly AudioTrack[], clip: AudioClip): number {
  const track = tracks.find((entry) => entry.id === clip.trackId)
  if (!track || track.muted) return 0
  return Math.max(0, track.volume)
}

/**
 * The tracks a project should start with.
 *
 * No countdown lane: it appears the first time beeps are added and stays out of
 * the way of everyone who never asks for one.
 */
export function defaultTracks(voiceId: string, musicId: string): AudioTrack[] {
  return [
    { id: voiceId, kind: 'voice', name: 'Voice 1', muted: false, volume: DEFAULT_VOLUME.voice },
    { id: musicId, kind: 'music', name: 'Music 1', muted: false, volume: DEFAULT_VOLUME.music },
  ]
}

/**
 * Brings a stored project up to the multitrack shape.
 *
 * Projects saved before this feature hold a flat `voiceovers` list with no
 * track at all. Rather than dumping them onto one lane — where takes that
 * overlapped would fight each other — each is replayed through the same
 * first-fit placement used for new recordings, so an old project opens with
 * its layers already separated.
 *
 * `makeId` is injected so this stays pure and testable.
 */
export function migrateProject(project: Project, makeId: (prefix: string) => string): Project {
  const alreadyMigrated = Array.isArray(project.audioTracks) && Array.isArray(project.audioClips)
  if (alreadyMigrated && !project.voiceovers?.length) {
    return project.voiceovers ? stripLegacy(project) : project
  }

  let tracks: AudioTrack[] = alreadyMigrated
    ? [...project.audioTracks]
    : defaultTracks(makeId('track'), makeId('track'))
  let clips: AudioClip[] = alreadyMigrated ? [...project.audioClips] : []

  for (const take of project.voiceovers ?? []) {
    const result = placeAudioClip(tracks, clips, {
      kind: 'voice',
      newTrackId: makeId('track'),
      clip: fromLegacyTake(take),
    })
    tracks = result.tracks
    clips = result.clips
  }

  return stripLegacy({ ...project, audioTracks: tracks, audioClips: clips })
}

function fromLegacyTake(take: LegacyVoiceoverTake): Omit<AudioClip, 'trackId'> {
  return {
    id: take.id,
    assetId: take.assetId,
    useConverted: take.useConverted,
    startTime: take.startTime,
    inPoint: 0,
    duration: take.duration,
    ...(take.convertedAssetId ? { convertedAssetId: take.convertedAssetId } : {}),
    ...(take.voiceName ? { voiceName: take.voiceName } : {}),
  }
}

function stripLegacy(project: Project): Project {
  const { voiceovers: _dropped, ...rest } = project
  return rest
}

/** Slack for comparing times. Far below one frame at any usable rate. */
const TIME_EPSILON = 1e-6

/**
 * The picture clip a piece of audio belongs to, judged by where it starts.
 *
 * Audio past the end of the picture gets no anchor rather than being handed the
 * last clip: a line read over black does not belong to the shot before it, and
 * tying it to one would drag it around every time that shot moved.
 */
export function anchorClipAt(
  positioned: readonly PositionedClip[],
  startTime: number,
): string | undefined {
  return positioned.find((entry) => startTime >= entry.start && startTime < entry.end)?.clip.id
}

/**
 * Carries anchored audio along with the picture.
 *
 * Keeps each clip's offset into the clip it is anchored to, so a line read two
 * seconds into a shot is still two seconds into that shot wherever the shot has
 * gone. Anything without an anchor is left alone, which is what keeps a music
 * bed sitting where it was laid.
 *
 * Unlike a caption, an anchored clip is *not* clipped to its shot. A voiceover
 * running on past the end of the clip it starts over is ordinary — the line
 * carries into the next shot — and truncating it would silently cut somebody's
 * words off. Only the start is tied.
 *
 * Returns null when nothing moved, so a caller can keep the array it has.
 */
export function audioUnderClips(
  clips: readonly AudioClip[],
  before: readonly PositionedClip[],
  after: readonly PositionedClip[],
): AudioClip[] | null {
  if (clips.length === 0) return null
  const was = new Map(before.map((entry) => [entry.clip.id, entry]))
  const now = new Map(after.map((entry) => [entry.clip.id, entry]))

  let changed = false
  const next = clips.map((clip) => {
    const anchor = clip.anchorClipId
    if (anchor === undefined) return clip
    const from = was.get(anchor)
    const to = now.get(anchor)
    // An anchor naming a clip that has been deleted leaves the audio where it
    // is. There is nowhere better to put it, and silently dragging it to the
    // start would be worse than leaving it to be moved by hand.
    if (!from || !to) return clip

    const startTime = Math.max(0, to.start + (clip.startTime - from.start))
    if (Math.abs(startTime - clip.startTime) < TIME_EPSILON) return clip
    changed = true
    return { ...clip, startTime }
  })
  return changed ? next : null
}
