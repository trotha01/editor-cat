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
import type { AudioClip, AudioTrack, AudioTrackKind, LegacyVoiceoverTake, Project } from './types'

/** Unity gain for narration; score sits under it by default. */
const DEFAULT_VOICE_VOLUME = 1
const DEFAULT_MUSIC_VOLUME = 0.5

/** Clips closer than this are treated as touching, not overlapping. */
const OVERLAP_EPSILON = 0.001

export interface TimeRange {
  startTime: number
  duration: number
}

export function clipEnd(clip: TimeRange): number {
  return clip.startTime + Math.max(0, clip.duration)
}

/** True if two ranges share any time. Touching end-to-start does not count. */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  // A range with no length occupies no time, so it can never collide. Without
  // this a degenerate clip would block the whole lane from its start onwards.
  if (a.duration <= 0 || b.duration <= 0) return false
  return a.startTime < clipEnd(b) - OVERLAP_EPSILON && b.startTime < clipEnd(a) - OVERLAP_EPSILON
}

export function clipsOnTrack(clips: readonly AudioClip[], trackId: string): AudioClip[] {
  return clips.filter((clip) => clip.trackId === trackId)
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
  return !clipsOnTrack(clips, trackId).some(
    (clip) => clip.id !== ignoreClipId && rangesOverlap(clip, range),
  )
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
  return tracks.find((track) => track.kind === kind && trackHasRoom(clips, track.id, range)) ?? null
}

/** Names new tracks "Voice 1", "Voice 2", … counting only that kind. */
export function nextTrackName(tracks: readonly AudioTrack[], kind: AudioTrackKind): string {
  const label = kind === 'voice' ? 'Voice' : 'Music'
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
    volume: kind === 'music' ? DEFAULT_MUSIC_VOLUME : DEFAULT_VOICE_VOLUME,
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
 * Moves a clip in time and optionally to another track, refusing the move if
 * it would land on top of something. Returns the clips unchanged when blocked,
 * so a bad drag is a no-op rather than a silent overlap.
 */
export function moveAudioClip(
  clips: readonly AudioClip[],
  clipId: string,
  next: { startTime: number; trackId?: string },
): { clips: AudioClip[]; moved: boolean } {
  const clip = clips.find((entry) => entry.id === clipId)
  if (!clip) return { clips: [...clips], moved: false }

  const trackId = next.trackId ?? clip.trackId
  const startTime = Math.max(0, next.startTime)
  const range = { startTime, duration: clip.duration }

  if (!trackHasRoom(clips, trackId, range, clipId)) {
    return { clips: [...clips], moved: false }
  }

  return {
    clips: clips.map((entry) => (entry.id === clipId ? { ...entry, trackId, startTime } : entry)),
    moved: true,
  }
}

/** When the last audio finishes, in seconds. */
export function audioEnd(clips: readonly AudioClip[]): number {
  return clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0)
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

/** The tracks a project should start with. */
export function defaultTracks(voiceId: string, musicId: string): AudioTrack[] {
  return [
    { id: voiceId, kind: 'voice', name: 'Voice 1', muted: false, volume: DEFAULT_VOICE_VOLUME },
    { id: musicId, kind: 'music', name: 'Music 1', muted: false, volume: DEFAULT_MUSIC_VOLUME },
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
