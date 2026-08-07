/**
 * One line over the picture saying whether what you are about to watch is
 * actually there yet.
 *
 * The preview's clock does not wait for media — it cannot, with stills and
 * layered audio on the same timebase — so a clip whose bytes are still arriving
 * shows as a held frame and then a jump. That reads as a broken editor. This is
 * the difference between "the playback is stuttering" and "two clips are still
 * loading", which is the whole reason for showing it.
 *
 * It says nothing once everything is ready, because then there is nothing to
 * say and a permanent badge over the picture is only something in the way.
 */
import { summarise } from '../lib/readiness'
import { useClipReadiness } from '../state/useClipReadiness'
import { useProjectStore } from '../state/useProjectStore'
import { Spinner } from './ui'

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function ReadinessBanner() {
  const clips = useProjectStore((state) => state.project.clips)
  const byClip = useClipReadiness((state) => state.byClip)

  if (clips.length === 0) return null

  const { missing, loading, stalled } = summarise(
    clips.map((clip) => clip.id),
    byClip,
  )

  if (missing === 0 && loading === 0) return null

  const parts: string[] = []
  // Stalling beats counting: the picture in front of you has stopped, and that
  // is what wants explaining before how many other clips are still coming.
  if (stalled) parts.push('Buffering — playback is waiting on this clip')
  else if (loading > 0) parts.push(`Loading ${plural(loading, 'clip')}…`)
  if (missing > 0) parts.push(`${plural(missing, 'clip')} with no media`)

  return (
    <div
      // Announced rather than only drawn: someone who cannot see the held frame
      // has even less to go on about why the sound just jumped.
      role="status"
      // Its own colours rather than the shared Callout: this sits over
      // arbitrary picture, so it has to stay legible against anything.
      // Never wider than the picture it sits on: a vertical project on a short
      // window is a narrow strip, and half a sentence disappearing off the edge
      // of it reads worse than the same sentence cut short on purpose.
      className={`pointer-events-none absolute top-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white ${
        loading === 0 ? 'bg-red-900/80' : 'bg-black/60'
      }`}
    >
      {/* The spinner announces itself as "Working", which would be a second
          status inside this one saying less than this one already does. */}
      <span aria-hidden className="inline-flex shrink-0">
        {loading > 0 ? <Spinner className="size-3 text-white" /> : '⚠'}
      </span>
      <span className="truncate">{parts.join(' · ')}</span>
    </div>
  )
}
