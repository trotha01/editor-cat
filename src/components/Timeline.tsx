/**
 * The timeline: one visual track, plus the voiceover track beneath it.
 *
 * Clips sit end to end with no gaps, which is the single simplification that
 * keeps this understandable. There is no ripple mode, no gap to accidentally
 * leave behind, and no way to end up with silent black frames you did not ask
 * for — trimming a clip simply pulls everything after it earlier.
 *
 * The one exception is the lead-in: a single stretch of black in front of the
 * first clip, which slides the whole picture track later so a count-in can play
 * before anything is on screen. It stays an exception rather than becoming
 * arbitrary gaps because there is only ever one of them, it is always at the
 * front, and it is one number on the project rather than a property of a clip.
 *
 * Widths are proportional to duration, with a pixels-per-second zoom, so what
 * you see matches what you get.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AssetThumb } from './AssetThumb'
import { Button } from './ui'
import {
  MAX_LEAD_IN,
  MIN_CLIP_DURATION,
  clipAtTime,
  clipDuration,
  clipGain,
  cutTargetAt,
  formatTime,
  frameDuration,
  isThroughCut,
  layoutClips,
  leadInOf,
  snapToFrame,
  totalDuration,
} from '../lib/timeline'
import { audioEnd } from '../lib/audioTracks'
import { isTypingTarget } from '../lib/shortcuts'
import { AudioTrackHeaders, AudioTrackLanes, TRACK_GUTTER_WIDTH } from './AudioTrackLanes'
import { ClipWaveformLane, WAVEFORM_LANE_HEIGHT, type WaveformEntry } from './ClipWaveforms'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import type { Asset, Clip, PositionedClip } from '../lib/types'

const MIN_ZOOM = 8
// High enough that individual frames get room of their own: cutting is only
// really frame-accurate if you can see the frame you are aiming at.
const MAX_ZOOM = 480

/** Below this, frame lines are noise rather than a guide, so they are hidden. */
const MIN_FRAME_LINE_PX = 6
/** What "Show frames" zooms to: comfortably clear of the threshold above. */
const FRAME_LINE_TARGET_PX = 12

/** How wide one frame is on screen at a given zoom. */
function framePixels(zoom: number, fps: number): number {
  return zoom * frameDuration(fps)
}

/** The zoom that gives frames their target width, capped at what the slider allows. */
function zoomForFrameLines(fps: number): number {
  return Math.min(MAX_ZOOM, FRAME_LINE_TARGET_PX / frameDuration(fps))
}

/**
 * The frame grid, as a repeating gradient rather than one element per frame:
 * a minute of 30fps timeline is 1800 lines, and that many nodes makes scrolling
 * the timeline stutter for something that is only a backdrop.
 *
 * Over the clips it is drawn as a dark hairline with a light one beside it, so
 * it stays visible against whatever the picture happens to be.
 */
function frameGrid(pixels: number, overMedia: boolean): string {
  const period = `${pixels}px`
  if (!overMedia) {
    return `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${period})`
  }
  return (
    `repeating-linear-gradient(to right, rgb(0 0 0 / 0.45) 0 1px, transparent 1px ${period}),` +
    `repeating-linear-gradient(to right, transparent 0 1px, rgb(255 255 255 / 0.45) 1px 2px, transparent 2px ${period})`
  )
}

function ClipCard({
  entry,
  asset,
  zoom,
  selected,
  cutAtStart,
  onSelect,
  onTrim,
  onRemove,
  onJoin,
}: {
  entry: PositionedClip
  asset: Asset | undefined
  zoom: number
  selected: boolean
  /** True when this clip carries on from the one before it — i.e. a cut. */
  cutAtStart: boolean
  onSelect: () => void
  onTrim: (edge: 'start' | 'end', seconds: number) => void
  onRemove: () => void
  onJoin: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.clip.id,
  })

  const dragState = useRef<{ edge: 'start' | 'end'; startX: number; origin: number } | null>(null)

  const beginTrim = (event: React.PointerEvent, edge: 'start' | 'end') => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    // Pointer capture keeps the drag alive even when the cursor leaves the
    // handle, which it always does once you drag more than a few pixels.
    target.setPointerCapture(event.pointerId)
    dragState.current = {
      edge,
      startX: event.clientX,
      origin: edge === 'start' ? entry.clip.inPoint : entry.clip.outPoint,
    }
  }

  const moveTrim = (event: React.PointerEvent) => {
    const state = dragState.current
    if (!state) return
    const deltaSeconds = (event.clientX - state.startX) / zoom
    onTrim(state.edge, state.origin + deltaSeconds)
  }

  const endTrim = (event: React.PointerEvent) => {
    if (!dragState.current) return
    dragState.current = null
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const width = Math.max(36, entry.duration * zoom)
  const isImage = asset?.kind === 'image'

  return (
    <div
      ref={setNodeRef}
      style={{
        width,
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      className={`group relative h-20 shrink-0 overflow-hidden rounded-lg border bg-surface-2 ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
        aria-label={`Select clip ${asset?.name ?? ''}`}
        {...attributes}
        {...listeners}
      >
        {asset ? (
          <AssetThumb asset={asset} className="size-full rounded-none border-0" />
        ) : (
          <span className="flex size-full items-center justify-center text-xs text-red-700">
            media missing
          </span>
        )}
      </button>

      {/* Sits on top of the thumbnail, so this pair stays white-on-scrim
          rather than following the theme — the media below can be any colour. */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex gap-1 truncate bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
        {formatTime(entry.duration)}
        {/* Only silence is marked. A speaker on every clip would say nothing:
            most of them have sound and it plays by default. */}
        {asset?.kind === 'video' && clipGain(entry.clip) <= 0 ? (
          <span role="img" aria-label="sound muted">
            🔇
          </span>
        ) : null}
      </span>

      {/* Trim handles. The left one is hidden for stills: an image has no
          in-point to move, so only its length is meaningful. */}
      {!isImage ? (
        <div
          role="slider"
          tabIndex={0}
          aria-label="Trim clip start"
          aria-valuenow={Math.round(entry.clip.inPoint * 10) / 10}
          aria-valuemin={0}
          aria-valuemax={Math.round(entry.clip.outPoint * 10) / 10}
          onPointerDown={(event) => beginTrim(event, 'start')}
          onPointerMove={moveTrim}
          onPointerUp={endTrim}
          onPointerCancel={endTrim}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') onTrim('start', entry.clip.inPoint - 0.1)
            if (event.key === 'ArrowRight') onTrim('start', entry.clip.inPoint + 0.1)
          }}
          className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-accent/0 transition group-hover:bg-accent/70 focus-visible:bg-accent"
        />
      ) : null}

      <div
        role="slider"
        tabIndex={0}
        aria-label={isImage ? 'Change how long this image is shown' : 'Trim clip end'}
        aria-valuenow={Math.round(entry.duration * 10) / 10}
        aria-valuemin={MIN_CLIP_DURATION}
        aria-valuemax={asset?.duration ?? 60}
        onPointerDown={(event) => beginTrim(event, 'end')}
        onPointerMove={moveTrim}
        onPointerUp={endTrim}
        onPointerCancel={endTrim}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onTrim('end', entry.clip.outPoint - 0.1)
          if (event.key === 'ArrowRight') onTrim('end', entry.clip.outPoint + 0.1)
        }}
        className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-accent/0 transition group-hover:bg-accent/70 focus-visible:bg-accent"
      />

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove clip from the timeline"
        className="absolute top-1 right-1 hidden size-5 items-center justify-center rounded bg-black/70 text-xs text-white group-hover:flex"
      >
        ✕
      </button>

      {/* A cut you made, still here because the two halves are still two clips.
          The line marks it; the button takes it back out again, which is the
          only undo this editor has. */}
      {cutAtStart ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 border-l-2 border-dashed border-accent"
          />
          <button
            type="button"
            onClick={onJoin}
            aria-label={`Undo the cut at ${formatTime(entry.start)}`}
            title="Undo this cut — joins this clip back onto the one before it"
            className="absolute top-1 left-3 hidden size-5 items-center justify-center rounded bg-black/70 text-[10px] text-white group-hover:flex"
          >
            ✂
          </button>
        </>
      ) : null}
    </div>
  )
}

/**
 * Diagonal hatching, so the gap in front of the picture reads as deliberately
 * empty rather than as a clip that failed to load.
 */
const LEAD_IN_HATCH =
  'repeating-linear-gradient(45deg, var(--color-line) 0 5px, transparent 5px 12px)'

/**
 * The black in front of the picture, and the handle for changing it.
 *
 * Dragging it is the direct way to slide the whole picture track later: what
 * you grab is the gap, and everything after it moves. The clips themselves
 * still sit end to end — there is only ever one gap, and it is always at the
 * front, which is what keeps this from turning into a timeline full of holes.
 */
function LeadInBlock({
  seconds,
  zoom,
  onChange,
}: {
  seconds: number
  zoom: number
  onChange: (seconds: number) => void
}) {
  const dragState = useRef<{ startX: number; origin: number } | null>(null)

  const beginDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    dragState.current = { startX: event.clientX, origin: seconds }
  }

  const moveDrag = (event: React.PointerEvent) => {
    const state = dragState.current
    if (!state) return
    onChange(state.origin + (event.clientX - state.startX) / zoom)
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!dragState.current) return
    dragState.current = null
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const width = seconds * zoom

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Lead-in before the picture"
      aria-valuenow={Math.round(seconds * 10) / 10}
      aria-valuemin={0}
      aria-valuemax={MAX_LEAD_IN}
      aria-valuetext={`${formatTime(seconds)} of black before the first clip`}
      title={`${formatTime(seconds)} of black before the picture — drag to slide the whole picture track`}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onChange(seconds - 0.1)
        if (event.key === 'ArrowRight') onChange(seconds + 0.1)
      }}
      style={{ width, backgroundImage: LEAD_IN_HATCH }}
      className="relative h-20 shrink-0 cursor-ew-resize overflow-hidden rounded-l-lg border border-r-0 border-dashed border-line bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-surface/80 px-1.5 py-0.5 text-[10px] text-ink-dim">
        ⏱ {formatTime(seconds)}
      </span>
      {/* The edge you are really dragging, marked so it can be aimed at. */}
      <span aria-hidden className="absolute inset-y-0 right-0 w-1 bg-accent/60" />
    </div>
  )
}

/** Whether the clip at `index` begins at a cut rather than at its own start. */
function cutBefore(positioned: readonly PositionedClip[], index: number): boolean {
  const previous = positioned[index - 1]?.clip
  const clip = positioned[index]?.clip
  return Boolean(previous && clip && isThroughCut(previous, clip))
}

export function Timeline({
  currentTime,
  onSeek,
}: {
  currentTime: number
  onSeek: (time: number) => void
}) {
  const project = useProjectStore((state) => state.project)
  const selectedClipId = useProjectStore((state) => state.selectedClipId)
  const selectClip = useProjectStore((state) => state.selectClip)
  const moveClip = useProjectStore((state) => state.moveClip)
  const removeClip = useProjectStore((state) => state.removeClip)
  const trim = useProjectStore((state) => state.trim)
  const cutAt = useProjectStore((state) => state.cutAt)
  const removeCut = useProjectStore((state) => state.removeCut)
  const assets = useAssetStore((state) => state.assets)

  const addTrack = useProjectStore((state) => state.addTrack)
  const setLeadIn = useProjectStore((state) => state.setLeadIn)

  const [zoom, setZoom] = useState(40)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const leadIn = leadInOf(project)
  const positioned = useMemo(() => layoutClips(project.clips, leadIn), [project.clips, leadIn])
  const visualDuration = totalDuration(project.clips)
  const pictureEndTime = leadIn + visualDuration

  // The clips that could have sound of their own. Worked out once here rather
  // than in the lane and again in the gutter, because the two have to agree
  // about whether the row exists or every row below it is a lane out of line.
  const soundEntries = useMemo<WaveformEntry[]>(
    () =>
      positioned.flatMap((entry) => {
        const asset = assetById.get(entry.clip.assetId)
        return asset?.kind === 'video' ? [{ entry, asset }] : []
      }),
    [positioned, assetById],
  )

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Where a cut would land, and whether one can land there at all. Recomputed
  // as the playhead moves, so the button says what pressing it would do.
  const cutTarget = useMemo(
    () => cutTargetAt(project.clips, currentTime, project.fps, leadIn),
    [project.clips, currentTime, project.fps, leadIn],
  )

  // The shortcut reads the playhead from a ref so it can be registered once.
  // Depending on `currentTime` directly would tear the listener down and put it
  // back on every animation frame of playback, for one key.
  const playheadRef = useRef(currentTime)
  useEffect(() => {
    playheadRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 's' && event.key !== 'S') return
      // Leave the browser's own Ctrl/Cmd-S and friends alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      // Already a no-op where nothing can be cut, so it needs no guard here.
      cutAt(playheadRef.current)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cutAt])

  const framePx = framePixels(zoom, project.fps)
  const frameLines = framePx >= MIN_FRAME_LINE_PX
  const canReachFrames = framePixels(MAX_ZOOM, project.fps) >= MIN_FRAME_LINE_PX

  const cutTitle = cutTarget
    ? `Cut at ${formatTime(snapToFrame(currentTime, project.fps))} (S)`
    : clipAtTime(project.clips, currentTime, leadIn)
      ? `Too close to the edge of this clip — a cut has to leave ${MIN_CLIP_DURATION}s on both sides.`
      : 'Park the playhead over a clip to cut it.'

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const from = project.clips.findIndex((clip) => clip.id === active.id)
      const to = project.clips.findIndex((clip) => clip.id === over.id)
      if (from >= 0 && to >= 0) moveClip(from, to)
    },
    [project.clips, moveClip],
  )

  const scrub = (event: React.MouseEvent<HTMLDivElement>) => {
    const ruler = trackRef.current
    if (!ruler) return
    // The ruler moves with the scroll container, so its own bounding box
    // already accounts for the scroll offset.
    const rect = ruler.getBoundingClientRect()
    // Snapped, so the playhead parks on a frame line rather than a pixel — the
    // cut is going to land on one of those anyway, and it should land on the
    // one you clicked.
    onSeek(snapToFrame((event.clientX - rect.left) / zoom, project.fps))
  }

  const playheadX = currentTime * zoom
  const audioEndTime = audioEnd(project.audioClips)
  // The lanes must span the audio too — a music bed longer than the picture
  // still has to be reachable and scrubbable.
  const contentWidth = Math.max(pictureEndTime, audioEndTime) * zoom

  return (
    <section className="flex flex-col gap-2" aria-label="Timeline">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <span className="text-xs text-ink-dim">
          {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} ·{' '}
          {formatTime(visualDuration)}
          {leadIn > 0 ? ` · from ${formatTime(leadIn)}` : ''}
          {project.audioTracks.length > 0
            ? ` · ${project.audioTracks.length} audio track${
                project.audioTracks.length === 1 ? '' : 's'
              }`
            : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => cutAt(currentTime)} disabled={!cutTarget} title={cutTitle}>
            <span aria-hidden>✂</span> Cut
          </Button>
          <Button onClick={() => addTrack('voice')} title="Add an empty voice track">
            + Voice track
          </Button>
          <Button onClick={() => addTrack('music')} title="Add an empty music track">
            + Music track
          </Button>
          {/* Only offered while the lines are hidden — once they are showing,
              the button would do nothing you could see. */}
          {!frameLines && canReachFrames ? (
            <Button
              variant="ghost"
              onClick={() => setZoom(zoomForFrameLines(project.fps))}
              title="Zoom in far enough to draw a line for every frame — cuts land on those lines"
            >
              Show frames
            </Button>
          ) : null}
          <label htmlFor="zoom" className="text-xs text-ink-dim">
            Zoom
          </label>
          <input
            id="zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-24"
          />
        </div>
      </header>

      {/* Track headers sit in a fixed gutter while the lanes scroll, so the
          mute and volume controls stay reachable at any scroll position. */}
      <div className="flex rounded-xl border border-line bg-surface">
        <div
          className="shrink-0 border-r border-line p-3 pr-2"
          style={{ width: TRACK_GUTTER_WIDTH }}
        >
          <div className="mb-2 h-6" aria-hidden />
          {/* The picture track's own controls, in the same gutter the audio
              tracks keep theirs in. Lead-in lives here because it is a property
              of the track rather than of any one clip — and because at zero
              there is nothing on the lane left to grab. */}
          <div className="mb-2 flex h-20 flex-col justify-center gap-1.5 text-xs text-ink-dim">
            <span className="font-medium">Picture</span>
            <label
              className="flex items-center gap-1"
              title="Black before the first clip, so a count-in can play before anything is on screen. Audio stays where it is."
            >
              Lead-in
              <input
                type="number"
                min={0}
                max={MAX_LEAD_IN}
                step={0.5}
                value={leadIn.toFixed(1)}
                onChange={(event) => setLeadIn(Number(event.target.value))}
                aria-label="Lead-in before the picture, in seconds"
                className="w-12 rounded border border-line bg-surface-2 px-1 py-0.5 text-xs text-ink"
              />
              s
            </label>
          </div>

          {soundEntries.length > 0 ? (
            <div
              className="mt-2 flex items-center gap-1.5 rounded bg-surface-2 px-2 text-[11px] text-ink-dim"
              style={{ height: WAVEFORM_LANE_HEIGHT }}
              title="What the video clips' own sound looks like. It belongs to the clips, so it is shown here rather than being a track you can drag."
            >
              <span aria-hidden>〰️</span>
              <span className="truncate font-medium">Clip sound</span>
            </div>
          ) : null}

          <AudioTrackHeaders />
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto p-3 pl-2">
          <div className="relative min-w-full" style={{ width: Math.max(contentWidth, 320) }}>
            {/* Ruler doubles as the scrub bar, and carries the frame grid: the
                lines run straight down into the picture track below, so the
                playhead can be parked on the frame you mean to cut. */}
            <div
              ref={trackRef}
              onClick={scrub}
              className="relative mb-2 h-6 cursor-pointer rounded bg-surface-2"
              style={frameLines ? { backgroundImage: frameGrid(framePx, false) } : undefined}
              role="presentation"
            >
              {Array.from({ length: Math.ceil(contentWidth / zoom) + 1 }, (_, second) => (
                <span
                  key={second}
                  className="absolute top-0 h-full border-l border-line pl-1 text-[10px] text-ink-dim"
                  style={{ left: second * zoom }}
                >
                  {second % (zoom < 20 ? 5 : 1) === 0 ? `${second}s` : ''}
                </span>
              ))}
            </div>

            <div className="relative">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToHorizontalAxis]}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={project.clips.map((clip) => clip.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  {/* No gap between the cards: with clips laid end to end, a gap
                      would push every later clip past where its own time is on
                      the ruler, and a frame line is no use if the picture under
                      it has drifted. */}
                  <div className="flex h-20">
                    {leadIn > 0 ? (
                      <LeadInBlock seconds={leadIn} zoom={zoom} onChange={setLeadIn} />
                    ) : null}
                    {positioned.length === 0 ? (
                      <p className="px-2 py-6 text-sm text-ink-dim">
                        Nothing on the timeline yet. Add a clip from the Library.
                      </p>
                    ) : (
                      positioned.map((entry) => (
                        <ClipCard
                          key={entry.clip.id}
                          entry={entry}
                          asset={assetById.get(entry.clip.assetId)}
                          zoom={zoom}
                          selected={entry.clip.id === selectedClipId}
                          cutAtStart={cutBefore(positioned, entry.index)}
                          onSelect={() => selectClip(entry.clip.id)}
                          onTrim={(edge, seconds) =>
                            trim(entry.clip.id, assetById.get(entry.clip.assetId), edge, seconds)
                          }
                          onRemove={() => removeClip(entry.clip.id)}
                          onJoin={() => removeCut(entry.clip.id)}
                        />
                      ))
                    )}
                  </div>
                </SortableContext>
              </DndContext>

              {frameLines && visualDuration > 0 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 bottom-0"
                  style={{
                    // Starts where the picture does: the grid is the frames of
                    // the clips, and the lead-in has none of its own.
                    left: leadIn * zoom,
                    width: visualDuration * zoom,
                    backgroundImage: frameGrid(framePx, true),
                  }}
                />
              ) : null}
            </div>

            <ClipWaveformLane entries={soundEntries} zoom={zoom} />

            <AudioTrackLanes zoom={zoom} />

            {contentWidth > 0 ? (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-red-500"
                style={{ left: playheadX }}
              />
            ) : null}
          </div>
        </div>
      </div>

      <SelectedClipControls />
    </section>
  )
}

/** Numeric editing for the selected clip, for when dragging is too coarse. */
function SelectedClipControls() {
  const selectedClipId = useProjectStore((state) => state.selectedClipId)
  const clips = useProjectStore((state) => state.project.clips)
  const setImageDuration = useProjectStore((state) => state.setImageDuration)
  const setClipAudio = useProjectStore((state) => state.setClipAudio)
  const trim = useProjectStore((state) => state.trim)
  const removeClip = useProjectStore((state) => state.removeClip)
  const assets = useAssetStore((state) => state.assets)

  const clip: Clip | undefined = clips.find((entry) => entry.id === selectedClipId)
  if (!clip) return null

  const asset = assets.find((entry) => entry.id === clip.assetId)
  const isImage = asset?.kind === 'image'
  const duration = clipDuration(clip)
  const volume = clip.volume ?? 1

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{asset?.name ?? 'Clip'}</p>
        <p className="text-xs text-ink-dim">
          {isImage
            ? 'Still image — set how long it stays on screen.'
            : `Showing ${formatTime(clip.inPoint)} to ${formatTime(clip.outPoint)} of the source.`}
        </p>
      </div>

      <label className="flex items-center gap-2 text-xs text-ink-dim">
        Length
        <input
          type="number"
          min={0.2}
          max={isImage ? 60 : (asset?.duration ?? 60)}
          step={0.1}
          aria-label="Selected clip length, in seconds"
          value={duration.toFixed(1)}
          onChange={(event) => {
            const seconds = Number(event.target.value)
            if (isImage) setImageDuration(clip.id, seconds)
            else trim(clip.id, asset, 'end', clip.inPoint + seconds)
          }}
          className="w-20 rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm text-ink"
        />
        s
      </label>

      {/* Sound, for clips that can have any. A filmed clip arrives with its own
          audio and plays it; this is where it gets pushed under a voiceover, or
          silenced when it is only there for the picture. */}
      {!isImage ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setClipAudio(clip.id, { muted: !clip.muted })}
            aria-pressed={clip.muted === true}
            aria-label={clip.muted ? 'Unmute this clip' : 'Mute this clip'}
            title={clip.muted ? 'Muted — click to unmute' : 'Mute this clip'}
            className={`shrink-0 text-sm ${clip.muted ? 'opacity-40' : ''}`}
          >
            {clip.muted ? '🔇' : '🔊'}
          </button>
          <label className="flex items-center gap-2 text-xs text-ink-dim">
            Clip volume
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={volume}
              disabled={clip.muted === true}
              onChange={(event) => setClipAudio(clip.id, { volume: Number(event.target.value) })}
              aria-label="Clip volume"
              title={`Volume ${Math.round(volume * 100)}%`}
              className="h-1 w-24"
            />
          </label>
        </div>
      ) : null}

      <Button variant="danger" className="ml-auto" onClick={() => removeClip(clip.id)}>
        Remove clip
      </Button>
    </div>
  )
}
