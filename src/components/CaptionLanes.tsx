/**
 * The caption half of the timeline.
 *
 * A caption is drawn as a block spanning the time it is on screen, with a tick
 * inside it for every word. That is the whole point of putting captions on the
 * timeline rather than only in a transcript: when a highlight lands late you can
 * see *why* — the word's tick is in the wrong place — and drag that one tick
 * without touching the line around it.
 *
 * Three drags live here and they must not be confused with one another, so each
 * grabs a different part of the block: the body moves the caption, the edges
 * change how long it is up, and a tick retimes a single word. A move that would
 * land on top of another caption is refused, for the same reason a second audio
 * clip may not share a lane — two captions on screen at once is not a caption.
 */
import { useRef, useState } from 'react'
import { Button } from './ui'
import { captionCuesOf, captionTracksOf, cuesOnTrack, wordSpans } from '../lib/captions'
import { formatTime } from '../lib/timeline'
import { useProjectStore } from '../state/useProjectStore'
import type { CaptionCue, CaptionTrack } from '../lib/types'

export const CAPTION_LANE_HEIGHT = 52

/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3

type Grab = 'move' | 'start' | 'end' | { wordId: string }

interface DragState {
  cueId: string
  pointerId: number
  grab: Grab
  startX: number
  /** The value the grabbed thing had when the drag began. */
  origin: number
  moved: boolean
}

export function CaptionLanes({ zoom, onSeek }: { zoom: number; onSeek: (time: number) => void }) {
  const tracks = useProjectStore((state) => captionTracksOf(state.project))
  const cues = useProjectStore((state) => captionCuesOf(state.project))
  const selected = useProjectStore((state) => state.selectedCaption)
  const selectCaption = useProjectStore((state) => state.selectCaption)
  const moveCueTo = useProjectStore((state) => state.moveCueTo)
  const trimCueEdge = useProjectStore((state) => state.trimCueEdge)
  const setCueWordTiming = useProjectStore((state) => state.setCueWordTiming)

  const dragRef = useRef<DragState | null>(null)
  const [blockedCueId, setBlockedCueId] = useState<string | null>(null)

  const beginDrag = (event: React.PointerEvent, cue: CaptionCue, grab: Grab) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)

    const origin =
      typeof grab === 'object'
        ? (cue.words.find((word) => word.id === grab.wordId)?.start ?? cue.start)
        : grab === 'end'
          ? cue.end
          : cue.start

    dragRef.current = {
      cueId: cue.id,
      pointerId: event.pointerId,
      grab,
      startX: event.clientX,
      origin,
      moved: false,
    }
    selectCaption({ cueId: cue.id, wordId: typeof grab === 'object' ? grab.wordId : null })
  }

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const dx = event.clientX - drag.startX
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD) return
    drag.moved = true

    const next = drag.origin + dx / zoom

    if (typeof drag.grab === 'object') {
      setCueWordTiming(drag.cueId, drag.grab.wordId, { start: next })
      return
    }
    if (drag.grab === 'move') {
      setBlockedCueId(moveCueTo(drag.cueId, next) ? null : drag.cueId)
      return
    }
    setBlockedCueId(trimCueEdge(drag.cueId, drag.grab, next) ? null : drag.cueId)
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setBlockedCueId(null)
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  if (tracks.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-1">
      {tracks.map((track) => (
        <div
          key={track.id}
          className={`relative rounded ${track.hidden ? 'bg-surface-2/40' : 'bg-surface-2'}`}
          style={{ height: CAPTION_LANE_HEIGHT }}
        >
          {cuesOnTrack(cues, track.id).map((cue) => (
            <CueBlock
              key={cue.id}
              cue={cue}
              track={track}
              zoom={zoom}
              selected={selected?.cueId === cue.id}
              selectedWordId={selected?.cueId === cue.id ? selected.wordId : null}
              blocked={blockedCueId === cue.id}
              onGrab={(event, grab) => beginDrag(event, cue, grab)}
              onDragMove={onDragMove}
              onDragEnd={endDrag}
              onSeek={onSeek}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function CueBlock({
  cue,
  track,
  zoom,
  selected,
  selectedWordId,
  blocked,
  onGrab,
  onDragMove,
  onDragEnd,
  onSeek,
}: {
  cue: CaptionCue
  track: CaptionTrack
  zoom: number
  selected: boolean
  selectedWordId: string | null
  blocked: boolean
  onGrab: (event: React.PointerEvent, grab: Grab) => void
  onDragMove: (event: React.PointerEvent) => void
  onDragEnd: (event: React.PointerEvent) => void
  onSeek: (time: number) => void
}) {
  const removeCue = useProjectStore((state) => state.removeCue)
  const width = Math.max(24, (cue.end - cue.start) * zoom)
  const text = cue.words.map((word) => word.text).join(' ')

  return (
    <div
      role="group"
      aria-label={
        `Caption "${text}", ${formatTime(cue.start)} to ${formatTime(cue.end)}` +
        (cue.source ? `, from ${cue.source.label}` : '')
      }
      style={{ left: cue.start * zoom, width }}
      className={`group/cue absolute top-1 bottom-1 overflow-hidden rounded border border-sky-600/40 bg-sky-500/15 text-sky-900 ${
        selected ? 'ring-2 ring-accent' : ''
      } ${blocked ? 'ring-2 ring-red-500' : ''} ${track.hidden ? 'opacity-40' : ''}`}
      title={
        blocked
          ? 'There is already a caption here — drop it somewhere with room.'
          : cue.source
            ? `${text}\n\nTranscribed from ${cue.source.label}`
            : text
      }
    >
      {/* The body of the block moves the whole caption. */}
      <div
        onPointerDown={(event) => onGrab(event, 'move')}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
      />

      <span className="pointer-events-none absolute inset-x-1.5 top-0.5 truncate text-[11px] font-medium">
        {text}
      </span>

      {/* One tick per word, at the moment its highlight begins. Dragging a tick
          retimes that word alone, which is the repair for a highlight that lands
          a beat off the voice. */}
      {wordSpans(cue).map((span) => (
        <button
          key={span.word.id}
          type="button"
          aria-label={`Word "${span.word.text}" at ${formatTime(span.word.start)} — drag to retime`}
          title={`${span.word.text} · ${formatTime(span.word.start)}`}
          onPointerDown={(event) => onGrab(event, { wordId: span.word.id })}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onClick={() => onSeek(span.word.start)}
          style={{ left: (span.word.start - cue.start) * zoom }}
          className={`absolute bottom-0 h-4 w-1.5 -translate-x-1/2 cursor-ew-resize rounded-t-sm ${
            span.word.id === selectedWordId ? 'bg-accent' : 'bg-sky-700/60 hover:bg-sky-700'
          }`}
        />
      ))}

      {/* Edges change how long the caption is up, leaving the words alone. */}
      {(['start', 'end'] as const).map((edge) => (
        <div
          key={edge}
          role="slider"
          tabIndex={0}
          aria-label={edge === 'start' ? 'When this caption appears' : 'When this caption leaves'}
          aria-valuenow={Math.round((edge === 'start' ? cue.start : cue.end) * 10) / 10}
          aria-valuemin={0}
          aria-valuemax={Math.round((cue.end + 60) * 10) / 10}
          onPointerDown={(event) => onGrab(event, edge)}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className={`absolute inset-y-0 w-2 cursor-ew-resize bg-accent/0 transition group-hover/cue:bg-accent/70 focus-visible:bg-accent ${
            edge === 'start' ? 'left-0' : 'right-0'
          }`}
        />
      ))}

      <Button
        variant="ghost"
        className="absolute top-0 right-0 hidden !px-1 !py-0 text-[10px] group-hover/cue:inline-flex"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => removeCue(cue.id)}
        aria-label={`Delete caption "${text}"`}
      >
        ✕
      </Button>
    </div>
  )
}

/** The fixed left column: one header per caption lane, aligned with the lanes. */
export function CaptionTrackHeaders() {
  const tracks = useProjectStore((state) => captionTracksOf(state.project))
  const cues = useProjectStore((state) => captionCuesOf(state.project))
  const updateCaptionTrack = useProjectStore((state) => state.updateCaptionTrack)
  const removeCaptionTrack = useProjectStore((state) => state.removeCaptionTrack)

  if (tracks.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-1">
      {tracks.map((track) => {
        const count = cuesOnTrack(cues, track.id).length
        return (
          <div
            key={track.id}
            className="flex items-center gap-1.5 rounded bg-surface-2 px-2"
            style={{ height: CAPTION_LANE_HEIGHT }}
          >
            <button
              type="button"
              onClick={() => updateCaptionTrack(track.id, { hidden: !track.hidden })}
              aria-pressed={track.hidden}
              aria-label={`${track.hidden ? 'Show' : 'Hide'} ${track.name}`}
              title={track.hidden ? 'Hidden — click to show' : 'Hide these captions'}
              className={`shrink-0 text-xs ${track.hidden ? 'opacity-40' : ''}`}
            >
              {track.hidden ? '🙈' : '💬'}
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium" title={track.name}>
                {track.name}
              </p>
              <p className="text-[10px] text-ink-dim">
                {count} caption{count === 1 ? '' : 's'}
              </p>
            </div>

            <Button
              variant="ghost"
              className="shrink-0 !px-1 !py-0 text-xs"
              onClick={() => {
                if (
                  count > 0 &&
                  !window.confirm(
                    `Delete "${track.name}" and its ${count} caption${count === 1 ? '' : 's'}?`,
                  )
                ) {
                  return
                }
                removeCaptionTrack(track.id)
              }}
              aria-label={`Delete caption track ${track.name}`}
            >
              ✕
            </Button>
          </div>
        )
      })}
    </div>
  )
}
