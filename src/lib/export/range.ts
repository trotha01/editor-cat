/**
 * The stretch of a timeline an export keeps.
 *
 * Its own module, and importing nothing but the type, because three layers need
 * the same answer and none of them should be resolving it themselves: the
 * dialog, which says how long the file will run before anyone commits a minute
 * of CPU to it; the export plan, which the render is built from; and the graph
 * builder, which has to be told the window in ffmpeg's own terms. A range
 * resolved differently by any of them is a dialog describing a file nobody gets.
 */
import type { ExportRange } from '../types'

/**
 * The shortest export worth producing.
 *
 * Not a frame — the frame rate is not known here, and a range this narrow is a
 * slip of the keyboard rather than an edit — but short enough that no
 * deliberate trim ever runs into it.
 */
export const MIN_EXPORT_LENGTH = 0.1

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(Math.max(value, low), high)
}

/**
 * A requested range, made safe against the timeline it is measured on.
 *
 * Absent is all of it, which is what an export is until someone says otherwise.
 * Everything else is clamped rather than refused: the numbers come from two
 * boxes someone is typing in, so out of order, past the end and half-entered
 * are ordinary states rather than errors, and a dialog that blanks out mid
 * keystroke is worse than one that shows where the value landed.
 */
export function clampExportRange(range: ExportRange | undefined, duration: number): ExportRange {
  const total = Math.max(0, Number.isFinite(duration) ? duration : 0)
  // Nothing to divide up: a timeline this short is the whole export whatever
  // was asked for, and the arithmetic below would have no room to work in.
  if (!range || total <= MIN_EXPORT_LENGTH) return { start: 0, end: total }

  const start = clamp(range.start, 0, total - MIN_EXPORT_LENGTH)
  return { start, end: clamp(range.end, start + MIN_EXPORT_LENGTH, total) }
}

/** Whether a resolved range leaves anything out, and so is worth acting on. */
export function isWholeTimeline(range: ExportRange, duration: number): boolean {
  return range.start <= 0 && range.end >= Math.max(0, duration)
}
