/**
 * A word's videos, watched as one thing.
 *
 * Not the editor's preview, and deliberately much less: there is no timeline
 * here, nothing is composited, and no frame is drawn by us. It is one `<video>`
 * whose source moves to the next take when the current one ends, which is all
 * "watch them together" needs to mean when the takes are whole files played in
 * order.
 *
 * Playing them in the order they are listed — rather than intro, then the words,
 * then outro — is the same decision the labels make: the order is the order you
 * dragged them into, and the player has no opinion about it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './ui'
import { useAssetSource } from '../hooks/useAssetUrl'
import { formatTime } from '../lib/timeline'
import { roleLabel, type WordVideo } from '../lib/words'
import type { Asset } from '../lib/types'

/** A video and the file behind it. Entries whose bytes are missing never get here. */
export interface PlayableVideo {
  video: WordVideo
  asset: Asset
}

export function WordSequencePlayer({ entries }: { entries: PlayableVideo[] }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const element = useRef<HTMLVideoElement>(null)

  // Deleting the take that was playing must not leave the player pointing past
  // the end of the run, so where we are is clamped on the way out rather than
  // corrected by an effect after the fact.
  const at = Math.min(index, Math.max(0, entries.length - 1))
  const current = entries[at]
  const source = useAssetSource(current?.asset)

  const total = useMemo(
    () => entries.reduce((sum, entry) => sum + (entry.asset.duration ?? 0), 0),
    [entries],
  )

  /**
   * The element follows this state rather than the other way about.
   *
   * Which is what makes one video ending and the next one starting a single
   * rule: `onEnded` moves us along, the source that arrives is a different URL,
   * and this plays it because we are still playing. A browser that refuses the
   * play — no gesture behind it, most often — puts the button back rather than
   * leaving it claiming to be playing something that is not.
   */
  useEffect(() => {
    const video = element.current
    if (!video || !source.url) return
    if (!playing) {
      video.pause()
      return
    }
    // An element sitting at the end of its file stays there when played, so
    // anything that arrives already finished — the same take twice over, or a
    // second run at the whole thing — is sent back to the start first.
    if (video.ended) video.currentTime = 0
    // `play()` hands back a promise in every browser that matters and nothing at
    // all in jsdom, so the refusal is caught through `Promise.resolve` rather
    // than off the return value directly.
    void Promise.resolve(video.play()).catch(() => setPlaying(false))
  }, [playing, source.url, at])

  if (entries.length === 0) return null

  const goTo = (next: number) => setIndex(Math.min(Math.max(next, 0), entries.length - 1))

  /**
   * The end of one take, which is either the start of the next or the end of
   * the lot — and the end of the lot rewinds rather than freezing on the last
   * frame, so pressing play again watches it from the top instead of doing
   * nothing.
   *
   * Playing is asserted again on the way through rather than merely left alone,
   * because it has just been taken away: reaching the end of a file pauses the
   * element and fires `pause` *before* it fires `ended`, so by the time we are
   * asked what to do next, the run has already been stopped underneath us. That
   * one line is the difference between watching a word through and pressing play
   * once per take.
   */
  const advance = () => {
    if (at + 1 < entries.length) {
      setIndex(at + 1)
      setPlaying(true)
      return
    }
    setPlaying(false)
    setIndex(0)
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
          Watch together
        </h3>
        <span className="text-xs text-ink-dim">
          {entries.length} {entries.length === 1 ? 'video' : 'videos'} · {formatTime(total)}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg bg-black">
        <video
          ref={element}
          src={source.url ?? undefined}
          playsInline
          // Not `controls`: the run is the thing being watched, and a native
          // scrub bar that stops at the end of take two would be describing a
          // different video from the one on screen.
          className="mx-auto max-h-80 w-full object-contain"
          onEnded={advance}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? 'Pause' : 'Play all'}
        >
          <span aria-hidden>{playing ? '⏸' : '▶️'}</span> {playing ? 'Pause' : 'Play all'}
        </Button>
        <Button onClick={() => goTo(at - 1)} disabled={at === 0} aria-label="Previous video">
          <span aria-hidden>⏮</span>
        </Button>
        <Button
          onClick={() => goTo(at + 1)}
          disabled={at >= entries.length - 1}
          aria-label="Next video"
        >
          <span aria-hidden>⏭</span>
        </Button>

        {current ? (
          <p className="min-w-0 flex-1 truncate text-xs text-ink-dim">
            {at + 1} of {entries.length} · {roleLabel(current.video.role)} · {current.asset.name}
          </p>
        ) : null}
      </div>

      {/* The transcript of whatever is on screen, which is the other half of
          watching these back: reading along is how you catch the take that says
          something slightly different from what it was supposed to. */}
      {current?.video.transcript?.trim() ? (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm leading-relaxed">
          {current.video.transcript}
        </p>
      ) : (
        <p className="px-3 py-2 text-sm text-ink-dim">No transcript for this one yet.</p>
      )}
    </div>
  )
}
