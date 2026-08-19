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

/**
 * Moves several clips at once, each to a start of its own, refusing the lot if
 * any one of them would land badly.
 *
 * All or nothing, because that is what "move them together" means: a group that
 * dropped the two clips with room and left the third where it was would have
 * silently changed the spacing between them, which is the one thing the group
 * was holding on to. Blocked leaves the clips untouched, the same as
 * `moveClipInLane` does with one.
 *
 * Only clips *outside* the moving set can block a placement. The ones inside it
 * are all being carried by the same distance, so they cannot newly collide with
 * each other — and testing them against where they used to be would refuse a
 * whole group for shuffling along its own lane by a second.
 *
 * Nothing changes lane here. A group spanning three lanes has no one lane to be
 * moved "down" from, so a group drag is along the timeline only.
 */
export function moveClipsInLane<T extends LaneClip>(
  clips: readonly T[],
  placements: readonly { id: string; startTime: number }[],
): { clips: T[]; moved: boolean } {
  // An empty group is allowed and changes nothing: a drag that happens to have
  // caught no clips on this lane must not fail the move on the lanes it did.
  if (placements.length === 0) return { clips: [...clips], moved: true }

  const wanted = new Map(placements.map((placement) => [placement.id, placement.startTime]))
  const staying = clips.filter((clip) => !wanted.has(clip.id))

  for (const clip of clips) {
    const startTime = wanted.get(clip.id)
    if (startTime === undefined) continue
    // Nothing may be pushed off the front of the timeline. Clamping the one
    // that hit zero instead would squash the group against the edge, which is
    // the same silent respacing the all-or-nothing rule exists to prevent.
    if (startTime < 0) return { clips: [...clips], moved: false }
    if (!trackHasRoom(staying, clip.trackId, { startTime, duration: clip.duration })) {
      return { clips: [...clips], moved: false }
    }
  }

  return {
    clips: clips.map((clip) => {
      const startTime = wanted.get(clip.id)
      return startTime === undefined ? clip : { ...clip, startTime }
    }),
    moved: true,
  }
}

/**
 * Where each of `ids` sits right now, for the ones that are clips on a lane.
 *
 * What a group drag has to hold on to at the press: ids alone are not enough to
 * move a group by a distance, and the clips themselves will have moved by the
 * next pointer event. Ids naming something that is not on a lane — a shot on
 * the picture track, swept up by the same band — are simply not here, which is
 * the right answer: they have no start to shift.
 */
export function laneOrigins<T extends LaneClip>(
  clips: readonly T[],
  ids: readonly string[],
): { id: string; startTime: number }[] {
  const wanted = new Set(ids)
  return clips
    .filter((clip) => wanted.has(clip.id))
    .map((clip) => ({ id: clip.id, startTime: clip.startTime }))
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
