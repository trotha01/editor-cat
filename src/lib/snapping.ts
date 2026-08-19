/**
 * Snapping for clips dragged along the audio, video and caption lanes: pull an
 * edge onto a nearby point where something else already begins or ends,
 * rather than leaving it wherever the pointer happened to land.
 *
 * Kept separate from the lane arithmetic in `lanes.ts` because it answers a
 * different question — not "does this fit" but "is there somewhere better
 * very close by" — and every lane asks it the same way regardless of what it
 * carries.
 */
import { layoutClips, leadInOf } from './timeline'
import { clipEnd } from './lanes'
import type { Project } from './types'

/** How close a dragged edge has to land to a point to snap onto it, in pixels. */
export const SNAP_DISTANCE_PX = 8

/** Slack for telling a clip's own edges apart from a point that just happens to coincide. */
const POINT_EPSILON = 1e-6

/**
 * Every point on the timeline something already begins or ends at: the
 * picture track's clips and its lead-in, and the start and end of every audio
 * clip, video layer and caption. Deduped, since a lot of these coincide — a
 * caption timed to a cut, an anchored voice line at its clip's start — and a
 * repeated point snaps no differently than one.
 */
export function snapPointsFor(project: Project): number[] {
  const leadIn = leadInOf(project)
  const points = new Set<number>([0, leadIn])
  for (const entry of layoutClips(project.clips, leadIn)) {
    points.add(entry.start)
    points.add(entry.end)
  }
  for (const clip of project.audioClips ?? []) {
    points.add(clip.startTime)
    points.add(clipEnd(clip))
  }
  for (const clip of project.videoClips ?? []) {
    points.add(clip.startTime)
    points.add(clipEnd(clip))
  }
  for (const cue of project.captionCues ?? []) {
    points.add(cue.start)
    points.add(cue.end)
  }
  return [...points].sort((a, b) => a - b)
}

/**
 * `points` with a clip's own current edges left out, so a clip being dragged
 * never snaps to the place it started from.
 */
export function withoutOwnEdges(
  points: readonly number[],
  ownStart: number,
  ownEnd: number,
): number[] {
  return points.filter(
    (point) =>
      Math.abs(point - ownStart) > POINT_EPSILON && Math.abs(point - ownEnd) > POINT_EPSILON,
  )
}

/** `candidate`, moved onto the nearest point within `threshold`, or left alone. */
export function snapTime(candidate: number, points: readonly number[], threshold: number): number {
  let nearest = candidate
  let nearestDistance = threshold
  for (const point of points) {
    const distance = Math.abs(point - candidate)
    if (distance < nearestDistance) {
      nearest = point
      nearestDistance = distance
    }
  }
  return nearest
}

/**
 * Where a clip being dragged by its body should land: whichever of its two
 * edges is closer to a point wins, so a clip dropped near another snaps flush
 * at either end rather than only the one happening to be watched.
 */
export function snapClipStart(
  start: number,
  duration: number,
  points: readonly number[],
  threshold: number,
): number {
  const snappedStart = snapTime(start, points, threshold)
  const end = start + duration
  const snappedEnd = snapTime(end, points, threshold)

  // Whether a point actually caught each edge, not just how far it moved —
  // an edge sitting exactly on its own unsnapped position also has zero
  // distance to "snap", and would otherwise be mistaken for the better match.
  const startCaught = snappedStart !== start
  const endCaught = snappedEnd !== end
  if (!startCaught && !endCaught) return start
  if (startCaught && !endCaught) return snappedStart
  if (!startCaught) return snappedEnd - duration

  const startDelta = Math.abs(snappedStart - start)
  const endDelta = Math.abs(snappedEnd - end)
  return startDelta <= endDelta ? snappedStart : snappedEnd - duration
}
