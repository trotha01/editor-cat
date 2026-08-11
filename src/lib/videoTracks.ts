/**
 * Picture layered over the picture track.
 *
 * The track of `clips` is still the spine of a project: gapless, cuttable, and
 * what the export is built around. These lanes are what goes over it. Keeping
 * them separate rather than turning the whole timeline into free-floating
 * layers is the decision this whole file rests on — a gapless spine is what
 * makes trimming ripple, cutting mean something, and "the picture ends here"
 * an answerable question. Layers on top cost none of that.
 *
 * So a video clip is shaped like an audio clip, not like a `Clip`: it has a
 * start time of its own, it may sit over black, and two of them on one lane are
 * refused rather than rippled apart. All of it is pure, and all of it is built
 * on the same lane arithmetic the audio tracks use.
 */
import { clipEnd, lanesEnd, laneWithRoom, moveClipInLane, trackHasRoom } from './lanes'
import type { Asset, Project, VideoClip, VideoTrack } from './types'

export { clipEnd } from './lanes'

/** What a still gets when dropped on a lane, matching the picture track. */
export const DEFAULT_OVERLAY_DURATION = 4
/** Shortest layer we allow, matching the picture track's own floor. */
export const MIN_OVERLAY_DURATION = 0.2
/** Longest a still may be held, matching the picture track's own cap. */
export const MAX_OVERLAY_DURATION = 60

/*
 * The empties these hand back for a project with no lanes.
 *
 * Shared constants rather than a fresh `[]` each call, and not an optional
 * detail: these are read through store selectors, which compare what they get
 * back by identity. A new array every time is a new value every time, so the
 * component re-renders, which reads them again — and the app hangs before it
 * has drawn a frame.
 */
const NO_TRACKS: VideoTrack[] = []
const NO_CLIPS: VideoClip[] = []

/**
 * The lanes a project has.
 *
 * Absent — which is every project saved before layering — is none, so an old
 * project opens looking exactly as it did.
 */
export function videoTracksOf(project: Pick<Project, 'videoTracks'>): VideoTrack[] {
  return project.videoTracks ?? NO_TRACKS
}

export function videoClipsOf(project: Pick<Project, 'videoClips'>): VideoClip[] {
  return project.videoClips ?? NO_CLIPS
}

/** Names new lanes "Video 1", "Video 2", … skipping any name already taken. */
export function nextVideoTrackName(tracks: readonly VideoTrack[]): string {
  const used = new Set(tracks.map((track) => track.name))
  for (let index = 1; ; index += 1) {
    const candidate = `Video ${index}`
    if (!used.has(candidate)) return candidate
  }
}

export function createVideoTrack(id: string, tracks: readonly VideoTrack[]): VideoTrack {
  return { id, name: nextVideoTrackName(tracks), hidden: false, opacity: 1 }
}

/**
 * Adds a lane on top of the others.
 *
 * Appended rather than inserted anywhere clever, because the order is the
 * stacking order: a lane you have just asked for is the one you are about to
 * put something on, and having it appear underneath what is already there
 * would be the opposite of what asking for it meant.
 */
export function addVideoTrack(tracks: readonly VideoTrack[], id: string): VideoTrack[] {
  return [...tracks, createVideoTrack(id, tracks)]
}

/** A clip for `asset`, as long as the asset is — or a still's default. */
export function videoClipForAsset(
  asset: Asset,
  id: string,
  trackId: string,
  startTime: number,
): VideoClip {
  const duration =
    asset.kind === 'image' ? DEFAULT_OVERLAY_DURATION : (asset.duration ?? DEFAULT_OVERLAY_DURATION)
  return {
    id,
    trackId,
    assetId: asset.id,
    startTime: Math.max(0, startTime),
    inPoint: 0,
    duration: Math.max(0, duration),
  }
}

/**
 * Where a new clip should go: the highest lane with room at that moment, or
 * none when every candidate is busy and the caller has to make a lane instead.
 *
 * The search runs from the top of the stack downwards, which is backwards
 * through the array, because later tracks draw over earlier ones. Taking the
 * first lane with room in array order — which is what this used to do — put a
 * new layer on the *lowest* free lane, underneath everything already on screen.
 * That is the one placement nobody ever asks for, since being over something is
 * the whole of what a layer is.
 *
 * `floorTrackId` is the selected layer's lane, and it is exactly that: a floor.
 * Nothing lands below the layer you had just pointed at, so adding picture while
 * a shot is selected stacks over that shot rather than behind it. The floor lane
 * itself stays in the running rather than only the lanes above it — dropping a
 * clip selects it, so ruling its lane out would make every drop after the first
 * spawn a lane of its own, and a montage of stills would end up ten lanes tall.
 * A floor naming a lane that has since been deleted is ignored rather than
 * treated as the bottom, which would be a floor nobody set.
 *
 * The reversal is done here rather than in `laneWithRoom` because the audio
 * lanes want the opposite and are right to: a voice take belongs on the first
 * free voice lane, not on whichever one happens to be highest.
 */
export function laneForClip(
  tracks: readonly VideoTrack[],
  clips: readonly VideoClip[],
  range: { startTime: number; duration: number },
  floorTrackId?: string,
): VideoTrack | null {
  const floor = floorTrackId ? tracks.findIndex((track) => track.id === floorTrackId) : -1
  const candidates = floor === -1 ? tracks : tracks.slice(floor)
  return laneWithRoom([...candidates].reverse(), clips, range)
}

/**
 * Moves a lane one step up or down the stack.
 *
 * "Up" is later in the array, because later tracks draw over earlier ones. That
 * is the one thing to keep hold of here: the timeline draws this array reversed
 * so that the top of the stack is at the top of the screen, so a control that
 * moves a lane up the screen has to move it up the stack — later — and reading
 * the reversed list as though it were the array gets it backwards silently.
 *
 * Nothing but the order changes. The clips stay on their lanes, and a lane's
 * opacity and its hidden flag mean exactly what they meant before, because
 * restacking is a change to what covers what and to nothing else.
 *
 * A lane already at the end it is being pushed towards comes back unchanged, as
 * does one that is not in the list at all, so a control left enabled at the top
 * of the stack is a no-op rather than a way to lose a lane.
 */
export function moveVideoTrack(
  tracks: readonly VideoTrack[],
  trackId: string,
  direction: 'up' | 'down',
): VideoTrack[] {
  const index = tracks.findIndex((track) => track.id === trackId)
  const target = index + (direction === 'up' ? 1 : -1)
  if (index === -1 || target < 0 || target >= tracks.length) return [...tracks]

  const next = [...tracks]
  const [moved] = next.splice(index, 1)
  if (!moved) return [...tracks]
  next.splice(target, 0, moved)
  return next
}

export function videoTrackHasRoom(
  clips: readonly VideoClip[],
  trackId: string,
  range: { startTime: number; duration: number },
  ignoreClipId?: string,
): boolean {
  return trackHasRoom(clips, trackId, range, ignoreClipId)
}

/** Moves a clip along its lane or to another, refusing an overlap. */
export function moveVideoClip(
  clips: readonly VideoClip[],
  clipId: string,
  next: { startTime: number; trackId?: string },
): { clips: VideoClip[]; moved: boolean } {
  return moveClipInLane(clips, clipId, next)
}

/**
 * Trims a clip's start or end, clamping to the source and to a floor.
 *
 * Dragging the start moves the in-point *and* the start time together, so the
 * frames that stay stay where they were on the timeline. Trimming the head off
 * a layer and having the rest slide left would move it off the moment it was
 * placed to hit, which is the only reason to place a layer by hand at all.
 */
export function trimVideoClip(
  clip: VideoClip,
  asset: Asset | undefined,
  edge: 'start' | 'end',
  /** The new in-point, or the new end measured in seconds into the source. */
  nextValue: number,
): VideoClip {
  const isImage = asset?.kind === 'image'
  const sourceLimit = isImage
    ? MAX_OVERLAY_DURATION
    : (asset?.duration ?? clip.inPoint + clip.duration)

  if (edge === 'start') {
    // A still has no in-point to move; only its length means anything.
    if (isImage) return clip
    const latest = clip.inPoint + clip.duration - MIN_OVERLAY_DURATION
    const wanted = clamp(nextValue, 0, Math.max(0, latest))
    // How far the head moves — and the one clamp that matters here. Limiting
    // the *distance* rather than the resulting start time is what keeps the
    // three numbers agreeing: clamping `startTime` on its own would leave the
    // in-point and the duration describing a clip that begins somewhere else,
    // sliding every frame and dragging the tail along with it.
    const moved = Math.max(wanted - clip.inPoint, -clip.startTime)
    return {
      ...clip,
      inPoint: clip.inPoint + moved,
      startTime: clip.startTime + moved,
      duration: Math.max(MIN_OVERLAY_DURATION, clip.duration - moved),
    }
  }

  const earliest = clip.inPoint + MIN_OVERLAY_DURATION
  const outPoint = clamp(nextValue, earliest, Math.max(earliest, sourceLimit))
  return { ...clip, duration: outPoint - clip.inPoint }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** When the last layer finishes, in seconds. */
export function videoLayersEnd(clips: readonly VideoClip[]): number {
  return lanesEnd(clips)
}

/** One layer on screen at a moment, with the track that decides how it draws. */
export interface VisibleLayer {
  clip: VideoClip
  track: VideoTrack
  /** Seconds into the source to show. */
  sourceTime: number
}

/**
 * What is layered over the picture at time `t`, bottom of the stack first.
 *
 * Ordered by the tracks rather than by the clips, because the track order *is*
 * the stacking order — reading it off the clip list would put whichever clip
 * happened to be added first at the bottom, and moving a clip would silently
 * restack the frame.
 */
export function layersAt(
  tracks: readonly VideoTrack[],
  clips: readonly VideoClip[],
  t: number,
): VisibleLayer[] {
  const layers: VisibleLayer[] = []
  for (const track of tracks) {
    if (track.hidden) continue
    for (const clip of clips) {
      if (clip.trackId !== track.id) continue
      if (t < clip.startTime || t >= clipEnd(clip)) continue
      layers.push({ clip, track, sourceTime: clip.inPoint + (t - clip.startTime) })
    }
  }
  return layers
}

/** Effective opacity for a clip, or 0 when its lane is hidden or gone. */
export function opacityFor(tracks: readonly VideoTrack[], clip: VideoClip): number {
  const track = tracks.find((entry) => entry.id === clip.trackId)
  if (!track || track.hidden) return 0
  return clamp(track.opacity, 0, 1)
}

/**
 * Gain for a layer's own sound, or 0 when it is muted or its lane is hidden.
 *
 * A hidden lane is silent as well as invisible. Half-hiding it — picture gone,
 * dialogue still playing — is not a state anyone means to be in, and it would
 * be a puzzle to diagnose from the export.
 */
export function layerGain(tracks: readonly VideoTrack[], clip: VideoClip): number {
  const track = tracks.find((entry) => entry.id === clip.trackId)
  if (!track || track.hidden || clip.muted) return 0
  return Math.max(0, clip.volume ?? 1)
}
