/**
 * The stretch of the timeline an export covers.
 *
 * Its own module rather than a field on the render request, because two
 * unrelated things have to agree about it: the encoder, which cuts the picture
 * and the sound to it, and the Mintspace fingerprint, which has to call half a
 * video a different video from the whole of it. Having no dependencies is what
 * lets the second one ask without dragging the encoder in behind it.
 */
import { clamp } from '../timeline'

/** Absolute timeline seconds — the same clock clip start times are on. */
export interface ExportRange {
  start: number
  /** Exclusive: the first moment that is no longer in the file. */
  end: number
}

/**
 * How near the whole thing still counts as the whole thing. One frame at 30fps
 * is 33ms, so a millisecond either side is not a range anybody chose — it is
 * float noise from formatting a duration and reading it back.
 */
const SLACK = 0.001

/**
 * A range fitted to a timeline of this length, or undefined for one that covers
 * all of it.
 *
 * Undefined rather than `{ start: 0, end: duration }` on purpose: absent is what
 * "no range" means everywhere downstream, so an export nobody has trimmed builds
 * exactly the filtergraph it built before ranges existed and fingerprints to
 * exactly the same key. Nothing already published stops being recognised for
 * the sake of a feature it never used.
 */
export function exportRangeOf(
  range: ExportRange | null | undefined,
  duration: number,
): ExportRange | undefined {
  if (!range) return undefined
  const total = Math.max(0, duration)
  const start = clamp(range.start, 0, total)
  // Clamped up from the start rather than from zero, so a nonsense pair cannot
  // come back as a negative length for the encoder to choke on.
  const end = clamp(range.end, start, total)
  if (start <= SLACK && end >= total - SLACK) return undefined
  return { start, end }
}
