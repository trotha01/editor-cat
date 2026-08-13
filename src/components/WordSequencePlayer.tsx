/**
 * A word's videos, watched as one thing — and ordered as one thing.
 *
 * Not the editor's preview, and deliberately much less: there is no timeline
 * here, nothing is composited, and no frame is drawn by us. It is one `<video>`
 * whose source moves to the next take when the current one ends, which is all
 * "watch them together" needs to mean when the takes are whole files played in
 * order.
 *
 * Under it the same run laid out left to right, which is where the order is
 * actually decided: the run reads as a sentence — this leads in, this is the
 * word, this signs off — and a strip of frames in a row is that sentence, in a
 * way a column of file names is not. Dragging a clip along it moves the take,
 * and because the ends of a run are what name themselves (`roleInRun`), the
 * labels follow the drag rather than the drag having to be followed by
 * relabelling two takes by hand.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AssetThumb } from './AssetThumb'
import { Button } from './ui'
import { useAssetSource } from '../hooks/useAssetUrl'
import { formatTime } from '../lib/timeline'
import { roleLabel, type WordVideo, type WordVideoRole } from '../lib/words'
import type { Asset } from '../lib/types'

/** A video and the file behind it. Entries whose bytes are missing never get here. */
export interface PlayableVideo {
  video: WordVideo
  asset: Asset
  /**
   * What it is labelled where it sits — worked out against the whole run rather
   * than in here, because a take whose file this browser has never held is still
   * in the run and can still be the intro. The strip would otherwise promote the
   * second take to intro on a machine that happens to be missing the first.
   */
  role: WordVideoRole | undefined
}

export function WordSequencePlayer({
  entries,
  /** Moves the take dragged onto another one into its place, both named by id. */
  onMove,
}: {
  entries: PlayableVideo[]
  onMove: (activeId: string, overId: string) => void
}) {
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

  // The same 6px before a drag begins as the list below, which is what leaves a
  // plain click on a clip free to mean "play this one".
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

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

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    onMove(String(active.id), String(over.id))
  }

  /**
   * Clicking a clip plays it, rather than merely selecting it.
   *
   * The click is a gesture, which is the one moment a browser will let a video
   * start on our say-so; asking to see a take and being handed a still of it
   * would waste that and need a second press for nothing.
   */
  const play = (next: number) => {
    goTo(next)
    setPlaying(true)
  }

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
            {at + 1} of {entries.length} · {current.role ? `${roleLabel(current.role)} · ` : ''}
            {current.asset.name}
          </p>
        ) : null}
      </div>

      {/* The run laid out in order, and the place it is put in order.
          `restrictToHorizontalAxis` because that is the only direction that
          means anything here — a clip lifted off the strip and dropped back
          nearby should land where it was, not wherever the pointer drifted. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={entries.map((entry) => entry.video.id)}
          strategy={horizontalListSortingStrategy}
        >
          <ol aria-label="Clips in order" className="flex gap-2 overflow-x-auto pb-1">
            {entries.map((entry, index) => (
              <Clip
                key={entry.video.id}
                entry={entry}
                current={index === at}
                onPlay={() => play(index)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

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

/**
 * One clip in the strip: a frame of it, what it is called, and what it is doing
 * in the run.
 *
 * The whole tile is the drag handle rather than a grip in the corner of it,
 * because a strip of frames is a thing people grab — which is also why it is not
 * the keyboard's way in. A pointer-only drag needs an equivalent that is not a
 * drag at all, and that is the pair of arrows on every row below; putting a
 * keyboard sensor here as well would take Space and Enter away from the tile and
 * leave no way to press it.
 */
function Clip({
  entry,
  current,
  onPlay,
}: {
  entry: PlayableVideo
  /** The one on screen, which the frame is ringed to match. */
  current: boolean
  onPlay: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.video.id,
  })

  const name = entry.asset.name

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`w-28 shrink-0 ${isDragging ? 'opacity-80' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={onPlay}
        aria-label={`Play ${name}`}
        aria-current={current ? 'true' : undefined}
        title={`${name} — click to play, drag to reorder`}
        className="flex w-full cursor-grab flex-col gap-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="relative block">
          <AssetThumb asset={entry.asset} selected={current} className="w-full" />
          {/* Sat on the frame rather than under it, so a clip with no label is
              the same height as one with a label and the strip does not step up
              and down along its length. */}
          {entry.role ? (
            <span className="absolute top-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase">
              {roleLabel(entry.role)}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[11px] text-ink-dim">{name}</span>
      </button>
    </li>
  )
}
