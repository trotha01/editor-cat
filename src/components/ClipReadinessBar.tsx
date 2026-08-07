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
  missing: 'bg-red-500',
  // Nothing has been fetched and nothing is meant to have been, so the fill is
  // empty and the track alone stands for it.
  idle: 'bg-transparent',
}

function describe(readiness: ClipReadiness): string {
  const percent = Math.round(readiness.buffered * 100)
  switch (readiness.state) {
    case 'ready':
      return 'Loaded — this clip will play through'
    case 'stalled':
      return `Playback is waiting on this clip — ${percent}% loaded`
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
        // Missing media has nothing loaded, but a hairline of nothing says
        // nothing — so the red runs the full width and the colour carries it.
        style={{ width: readiness.state === 'missing' ? '100%' : `${readiness.buffered * 100}%` }}
      />
    </span>
  )
}
