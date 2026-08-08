/**
 * What a lane is, independent of what it carries.
 *
 * Audio tracks and video tracks are the same idea twice: clips placed at a time
 * rather than laid end to end, one lane's worth able to be dragged along and
 * between lanes, and never allowed to sit on top of each other. The rule that
 * decides whether two clips collide has to be exactly one rule — two copies of
 * it would drift, and the half that drifted would let an overlap through that
 * only shows up on export.
 *
 * So the arithmetic lives here, generic over anything with a start and a length,
 * and both kinds of track are built on it.
 */

/** Clips closer than this are treated as touching, not overlapping. */
const OVERLAP_EPSILON = 0.001

export interface TimeRange {
  startTime: number
  duration: number
}

/** A clip on a lane: a range that knows which lane it is on and which clip it is. */
export interface LaneClip extends TimeRange {
  id: string
  trackId: string
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

export function clipsOnTrack<T extends { trackId: string }>(
  clips: readonly T[],
  trackId: string,
): T[] {
  return clips.filter((clip) => clip.trackId === trackId)
}

/**
 * Whether `range` fits on a track without colliding.
 * `ignoreClipId` lets a clip be tested against its own track while being moved.
 */
export function trackHasRoom<T extends LaneClip>(
  clips: readonly T[],
  trackId: string,
  range: TimeRange,
  ignoreClipId?: string,
): boolean {
  return !clipsOnTrack(clips, trackId).some(
    (clip) => clip.id !== ignoreClipId && rangesOverlap(clip, range),
  )
}

/**
 * Moves a clip in time and optionally to another lane, refusing the move if it
 * would land on top of something. Returns the clips unchanged when blocked, so
 * a bad drag is a no-op rather than a silent overlap.
 */
export function moveClipInLane<T extends LaneClip>(
  clips: readonly T[],
  clipId: string,
  next: { startTime: number; trackId?: string },
): { clips: T[]; moved: boolean } {
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

/** When the last of these clips finishes, in seconds. */
export function lanesEnd(clips: readonly TimeRange[]): number {
  return clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0)
}

/** The first lane with room for `range`, or null when they are all busy then. */
export function laneWithRoom<Track extends { id: string }, Clip extends LaneClip>(
  tracks: readonly Track[],
  clips: readonly Clip[],
  range: TimeRange,
  accepts: (track: Track) => boolean = () => true,
): Track | null {
  return tracks.find((track) => accepts(track) && trackHasRoom(clips, track.id, range)) ?? null
}
