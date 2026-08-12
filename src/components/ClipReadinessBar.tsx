/**
 * The strip along the top of a clip card saying how much of it is loaded.
 *
 * The same idea as a render bar in a cutting room: a glance along the track
 * tells you which stretches will play back cleanly and which will hitch, before
 * you press play and find out the hard way. Here it is buffering rather than
 * rendering, but the question it answers is the same one.
 *
 * Only the stretch the clip actually uses counts. Trim a three-minute source
 * down to two seconds and the bar fills once those two seconds are in hand,
 * because that is all the playhead is ever going to ask for.
 */
import { UNKNOWN, type ClipReadiness, type ReadinessState } from '../lib/readiness'
import { useClipReadiness } from '../state/useClipReadiness'

const FILLS: Record<ReadinessState, string> = {
  // Ready is deliberately quiet. It is the state nearly every clip is in nearly
  // all of the time, and a bright bar across all of them would say nothing.
  ready: 'bg-emerald-500/70',
  loading: 'bg-amber-400',
  stalled: 'bg-amber-400 animate-pulse',
  // Amber like the rest of the waiting, because that is what it is — the asset
  // has not turned up yet. It pulses rather than filling because there is no
  // element behind it to measure: how far along it is cannot be known, only
  // that it is still going.
  pending: 'bg-amber-400 animate-pulse',
  missing: 'bg-red-500',
  // Nothing has been fetched and nothing is meant to have been, so the fill is
  // empty and the track alone stands for it.
  idle: 'bg-transparent',
}

/** States with no progress to draw, where the width would only ever be nothing. */
const INDETERMINATE = new Set<ReadinessState>(['missing', 'pending'])

function describe(readiness: ClipReadiness): string {
  const percent = Math.round(readiness.buffered * 100)
  switch (readiness.state) {
    case 'ready':
      return 'Loaded — this clip will play through'
    case 'stalled':
      return `Playback is waiting on this clip — ${percent}% loaded`
    case 'pending':
      return 'Waiting on this clip’s media to arrive'
    case 'missing':
      return 'This clip’s media could not be loaded'
    case 'idle':
      return 'Not loaded yet — this clip is fetched as the playhead gets near'
    default:
      return `Loading — ${percent}% of what this clip uses`
  }
}

export function ClipReadinessBar({ clipId }: { clipId: string }) {
  const readiness = useClipReadiness((state) => state.byClip[clipId]) ?? UNKNOWN
  const label = describe(readiness)

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-1 bg-black/45"
    >
      <span
        aria-hidden
        className={`block h-full transition-[width] duration-300 ${FILLS[readiness.state]}`}
        // Neither of these has anything loaded, and a hairline of nothing says
        // nothing — so the fill runs the full width and the colour carries it:
        // red for media that is gone, amber for media still on its way.
        style={{
          width: INDETERMINATE.has(readiness.state) ? '100%' : `${readiness.buffered * 100}%`,
        }}
      />
    </span>
  )
}
