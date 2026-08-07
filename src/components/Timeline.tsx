/**
 * The timeline: one visual track, plus the voiceover track beneath it.
 *
 * Clips sit end to end with no gaps, which is the single simplification that
 * keeps this understandable. There is no ripple mode, no gap to accidentally
 * leave behind, and no way to end up with silent black frames you did not ask
 * for — trimming a clip simply pulls everything after it earlier.
 *
 * Widths are proportional to duration, with a pixels-per-second zoom, so what
 * you see matches what you get.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
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
import { MIN_CLIP_DURATION, clipDuration, clipGain, formatTime, layoutClips } from '../lib/timeline'
import { audioEnd } from '../lib/audioTracks'
import { AudioTrackHeaders, AudioTrackLanes, TRACK_GUTTER_WIDTH } from './AudioTrackLanes'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import type { Asset, Clip, PositionedClip } from '../lib/types'

const MIN_ZOOM = 8
const MAX_ZOOM = 200

function ClipCard({
  entry,
  asset,
  zoom,
  selected,
  onSelect,
  onTrim,
  onRemove,
}: {
  entry: PositionedClip
  asset: Asset | undefined
  zoom: number
  selected: boolean
  onSelect: () => void
  onTrim: (edge: 'start' | 'end', seconds: number) => void
  onRemove: () => void
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
    </div>
  )
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
  const assets = useAssetStore((state) => state.assets)

  const addTrack = useProjectStore((state) => state.addTrack)

  const [zoom, setZoom] = useState(40)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const positioned = useMemo(() => layoutClips(project.clips), [project.clips])
  const visualDuration = positioned.at(-1)?.end ?? 0

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

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
    onSeek(Math.max(0, (event.clientX - rect.left) / zoom))
  }

  const playheadX = currentTime * zoom
  const audioEndTime = audioEnd(project.audioClips)
  // The lanes must span the audio too — a music bed longer than the picture
  // still has to be reachable and scrubbable.
  const contentWidth = Math.max(visualDuration, audioEndTime) * zoom

  return (
    <section className="flex flex-col gap-2" aria-label="Timeline">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <span className="text-xs text-ink-dim">
          {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} ·{' '}
          {formatTime(visualDuration)}
          {project.audioTracks.length > 0
            ? ` · ${project.audioTracks.length} audio track${
                project.audioTracks.length === 1 ? '' : 's'
              }`
            : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => addTrack('voice')} title="Add an empty voice track">
            + Voice track
          </Button>
          <Button onClick={() => addTrack('music')} title="Add an empty music track">
            + Music track
          </Button>
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
          <div className="mb-2 flex h-20 items-center text-xs font-medium text-ink-dim">
            Picture
          </div>
          <AudioTrackHeaders />
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto p-3 pl-2">
          <div className="relative min-w-full" style={{ width: Math.max(contentWidth, 320) }}>
            {/* Ruler doubles as the scrub bar. */}
            <div
              ref={trackRef}
              onClick={scrub}
              className="relative mb-2 h-6 cursor-pointer rounded bg-surface-2"
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
                <div className="flex h-20 gap-0.5">
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
                        onSelect={() => selectClip(entry.clip.id)}
                        onTrim={(edge, seconds) =>
                          trim(entry.clip.id, assetById.get(entry.clip.assetId), edge, seconds)
                        }
                        onRemove={() => removeClip(entry.clip.id)}
                      />
                    ))
                  )}
                </div>
              </SortableContext>
            </DndContext>

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
