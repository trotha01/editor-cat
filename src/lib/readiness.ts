/**
 * How ready a clip is to play, and how to work that out.
 *
 * The preview runs on a clock of its own — `performance.now()` deltas, not any
 * one element's `currentTime` — so it never waits for media. That is what keeps
 * stills, videos and layered audio on the same timebase, but it also means a
 * clip whose bytes have not arrived does not slow the playhead down: the
 * picture holds on the last frame and then jumps to catch up. From the outside
 * that looks like a stutter, and there is nothing on screen to say otherwise.
 *
 * So the readiness is measured and shown. Not "did the file download" — the
 * useful question is narrower: is the stretch of source this clip actually uses
 * buffered? A three-minute video trimmed to two seconds needs those two
 * seconds and nothing else.
 *
 * No React and no DOM in here beyond the shape of `TimeRanges`, so the
 * arithmetic that decides what colour a clip goes can be tested directly.
 */

/**
 * The part of `TimeRanges` we use, so tests can hand in a plain object.
 * Ranges are sorted and non-overlapping, which is what lets the coverage below
 * be a simple sum rather than a merge.
 */
export interface Ranges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export type ReadinessState =
  /** The media is gone, or the element gave up trying to load it. */
  | 'missing'
  /**
   * The clip points at an asset the library has not got *yet*: the library is
   * still doing its first load, or the project's media is still coming back
   * from Drive. Kept apart from `missing` because the two look identical from
   * here and are opposites to the person watching — one is a wait and the other
   * is a fault — and apart from `loading` because there is no element to
   * measure, so there is no progress to report either.
   */
  | 'pending'
  /**
   * Not fetched yet, and not meant to be: this clip is far enough from the
   * playhead that we have deliberately not asked for it. Kept apart from
   * `loading` so a long timeline does not sit there reporting most of itself as
   * pending when nothing is actually waiting on anything.
   */
  | 'idle'
  /** Bytes are on their way. */
  | 'loading'
  /** Playback wanted this clip and it ran out of data. The visible stutter. */
  | 'stalled'
  /** The whole of what this clip uses is buffered. It will play through. */
  | 'ready'

export interface ClipReadiness {
  state: ReadinessState
  /** How much of the clip's own in→out range is buffered, 0 to 1. */
  buffered: number
}

/**
 * Buffering is never quite exact — a range can end a few sample-widths short of
 * the out-point and still play through — so "all of it" leaves a little room.
 */
const FULLY_BUFFERED = 0.995

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough to advance past the current frame. */
const HAVE_FUTURE_DATA = 3

/**
 * What a clip nothing has reported on yet is worth.
 *
 * `idle` rather than `loading`, so a timeline that has only just been laid out
 * is quiet: nothing has been asked for, so nothing is late.
 */
export const UNKNOWN: ClipReadiness = { state: 'idle', buffered: 0 }

/**
 * How much of `[from, to]` the given ranges cover, as a fraction.
 *
 * A zero-length window counts as covered: there is nothing to wait for, and a
 * degenerate clip should not sit there claiming to be loading forever.
 */
export function bufferedFraction(
  ranges: Ranges | null | undefined,
  from: number,
  to: number,
): number {
  const span = to - from
  if (!(span > 0)) return 1
  if (!ranges || ranges.length === 0) return 0

  let covered = 0
  for (let index = 0; index < ranges.length; index += 1) {
    const overlap = Math.min(to, ranges.end(index)) - Math.max(from, ranges.start(index))
    if (overlap > 0) covered += overlap
  }

  return Math.min(1, covered / span)
}

/**
 * Turns what an element knows about itself into what we show.
 *
 * `wanted` is the distinction that makes `stalled` worth having: an unbuffered
 * clip four cuts ahead is fine and needs no alarm, while the same clip under a
 * running playhead is the frozen picture the user is looking at right now.
 */
export function readinessFor({
  failed = false,
  readyState,
  buffered,
  wanted,
  warm,
}: {
  /** Set once the media has failed outright, rather than merely not arrived. */
  failed?: boolean
  /** `HTMLMediaElement.readyState`. */
  readyState: number
  /** Fraction of the clip's range that is buffered, from `bufferedFraction`. */
  buffered: number
  /** True when the playhead is on this clip and the transport is running. */
  wanted: boolean
  /** True when this clip is near enough the playhead to have been asked for. */
  warm: boolean
}): ClipReadiness {
  if (failed) return { state: 'missing', buffered: 0 }
  if (wanted && readyState < HAVE_FUTURE_DATA) return { state: 'stalled', buffered }
  if (buffered >= FULLY_BUFFERED) return { state: 'ready', buffered: 1 }
  return { state: warm ? 'loading' : 'idle', buffered }
}

/** True when two readings would look the same on screen, so one can be dropped. */
export function sameReadiness(a: ClipReadiness, b: ClipReadiness): boolean {
  return a.state === b.state && a.buffered === b.buffered
}

/**
 * Rounded to whole percent before it reaches the store.
 *
 * `progress` fires often and the fraction creeps by fractions of a percent;
 * without this, every one of those would be a state change and a re-render of
 * the whole timeline, during playback, for a bar nobody can see move.
 */
export function quantise(readiness: ClipReadiness): ClipReadiness {
  return { state: readiness.state, buffered: Math.round(readiness.buffered * 100) / 100 }
}

/** What the whole timeline adds up to, for the one-line summary over the picture. */
export interface ReadinessSummary {
  /** Clips whose media could not be loaded at all. */
  missing: number
  /**
   * Clips fetching now. Includes the stalled one, which is also still fetching,
   * and the ones still waiting on their asset to turn up at all.
   */
  loading: number
  /** Clips deliberately not fetched yet. Not a problem, so not counted above. */
  idle: number
  /** True when the clip under a running playhead has run out of data. */
  stalled: boolean
  /** How many clips this covers. */
  total: number
}

export function summarise(
  clipIds: readonly string[],
  byClip: Readonly<Record<string, ClipReadiness>>,
): ReadinessSummary {
  let missing = 0
  let loading = 0
  let idle = 0
  let stalled = false

  for (const id of clipIds) {
    switch (byClip[id]?.state ?? UNKNOWN.state) {
      case 'missing':
        missing += 1
        break
      case 'stalled':
        loading += 1
        stalled = true
        break
      // An asset that has not arrived is media on its way like any other, so
      // `pending` is counted here rather than accused of being absent.
      case 'loading':
      case 'pending':
        loading += 1
        break
      case 'idle':
        idle += 1
        break
    }
  }

  return { missing, loading, idle, stalled, total: clipIds.length }
}
