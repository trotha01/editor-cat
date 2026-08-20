/**
 * The video lanes: picture laid over the picture track.
 *
 * These behave like the audio lanes, not like the picture track — dragged along
 * to retime, dragged up and down between lanes, and refused rather than allowed
 * to overlap, because two clips stacked on one lane cannot both be the top of
 * that lane. The picture track stays what it is: gapless, cuttable, and the
 * thing everything else is measured against.
 *
 * Lanes are drawn bottom of the stack first, matching both the array order and
 * the order the exporter lays them on. What is lower in this list is lower in
 * the frame — and moving a lane along that order, from the controls in its
 * header, is the whole of restacking the picture.
 */
import { useRef, useState } from 'react'
import { AssetThumb } from './AssetThumb'
import { Button } from './ui'
import { ClipMenu } from './ClipMenu'
import { formatTime } from '../lib/timeline'
import { clipEnd, laneOrigins } from '../lib/lanes'
import { SNAP_DISTANCE_PX, snapClipStart, snapPointsFor, withoutOwnEdges } from '../lib/snapping'
import { MIN_OVERLAY_DURATION } from '../lib/videoTracks'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { useProjectsStore } from '../state/useProjectsStore'
import { videoClipsOf, videoTracksOf } from '../lib/videoTracks'
import type { Asset, VideoClip, VideoTrack } from '../lib/types'

export const VIDEO_LANE_HEIGHT = 40
/** The `gap-1` between lanes. A lane's pitch is its height plus this. */
const LANE_GAP = 4
const LANE_PITCH = VIDEO_LANE_HEIGHT + LANE_GAP

/** Vertical travel needed before a drag changes lanes, in pixels. */
const LANE_SWITCH_THRESHOLD = LANE_PITCH * 0.6

interface DragState {
  clipId: string
  pointerId: number
  startX: number
  startY: number
  originStart: number
  originTrackId: string
  moved: boolean
  /**
   * Where every clip of the marquee's group began, when the layer picked up is
   * part of one. Captured at the press for the reason the audio lanes capture
   * it there — see `DragState` in AudioTrackLanes.
   */
  group: readonly { id: string; startTime: number }[]
}

export function VideoTrackLanes({ zoom }: { zoom: number }) {
  const project = useProjectStore((state) => state.project)
  const tracks = videoTracksOf(project)
  const clips = videoClipsOf(project)
  const assets = useAssetStore((state) => state.assets)
  const assetsLoading = useAssetStore((state) => state.loading)
  const hydrating = useProjectsStore((state) => state.hydration !== null)
  // Mirrors the picture track: an asset absent from the library during either
  // of these is still on its way, not gone.
  const mediaLoading = assetsLoading || hydrating
  const moveVideoClipTo = useProjectStore((state) => state.moveVideoClipTo)
  const trimVideoClipEdge = useProjectStore((state) => state.trimVideoClipEdge)
  const removeVideoClip = useProjectStore((state) => state.removeVideoClip)
  const setVideoClipAudio = useProjectStore((state) => state.setVideoClipAudio)
  const selectedId = useProjectStore((state) => state.selectedVideoClipId)
  const selectVideoClip = useProjectStore((state) => state.selectVideoClip)
  const selectedIds = useProjectStore((state) => state.selectedIds)
  const moveClipsTo = useProjectStore((state) => state.moveClipsTo)

  const dragRef = useRef<DragState | null>(null)
  const [blockedClipId, setBlockedClipId] = useState<string | null>(null)

  const beginDrag = (event: React.PointerEvent, clip: VideoClip) => {
    if (event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const inGroup = selectedIds.includes(clip.id)
    dragRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originStart: clip.startTime,
      originTrackId: clip.trackId,
      moved: false,
      group: inGroup ? laneOrigins([...clips, ...(project.audioClips ?? [])], selectedIds) : [],
    }
    // A layer already in a group keeps it: picking it up is how the group moves.
    if (!inGroup) selectVideoClip(clip.id)
  }

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    drag.moved = true

    const clip = clips.find((entry) => entry.id === drag.clipId)
    if (!clip) return

    // Snapped against every other clip's edges, the same as the audio lanes —
    // lining a layer up with a cut or a caption by eye is not something a
    // pointer can do to the pixel.
    const rawStart = drag.originStart + dx / zoom
    const points = withoutOwnEdges(snapPointsFor(project), clip.startTime, clipEnd(clip))
    const start = snapClipStart(rawStart, clip.duration, points, SNAP_DISTANCE_PX / zoom)

    if (drag.group.length > 1) {
      // The whole group by the distance this layer travelled, and along the
      // timeline only — the same rule the audio lanes move a group by.
      const shift = start - drag.originStart
      const ok = moveClipsTo(
        drag.group.map((origin) => ({ id: origin.id, startTime: origin.startTime + shift })),
      )
      setBlockedClipId(ok ? null : drag.clipId)
      return
    }

    // Any lane will take any layer — unlike the audio lanes, where the kind
    // decides the gain, a video lane's only property is how it stacks, and
    // moving between them is exactly how you restack a shot.
    const originIndex = tracks.findIndex((track) => track.id === drag.originTrackId)
    let targetTrackId = drag.originTrackId
    if (Math.abs(dy) > LANE_SWITCH_THRESHOLD) {
      // Lanes are drawn bottom-first, so dragging *up* the screen is a step
      // later in the array.
      const laneDelta = -Math.round(dy / LANE_PITCH)
      const candidate = tracks[originIndex + laneDelta]
      if (candidate) targetTrackId = candidate.id
    }

    const ok = moveVideoClipTo(drag.clipId, start, targetTrackId)
    setBlockedClipId(ok ? null : drag.clipId)
  }

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setBlockedClipId(null)
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  if (tracks.length === 0) return null

  const assetById = new Map(assets.map((asset) => [asset.id, asset]))

  return (
    <div className="mt-2 flex flex-col gap-1">
      {/* Reversed for drawing only: the topmost lane in the stack is the one
          drawn highest on screen, while the array stays bottom-first because
          that is the order the frame is built up in. */}
      {[...tracks].reverse().map((track) => (
        <div
          key={track.id}
          className={`relative rounded ${track.hidden ? 'bg-surface-2/40' : 'bg-surface-2'}`}
          style={{ height: VIDEO_LANE_HEIGHT }}
        >
          {clips
            .filter((clip) => clip.trackId === track.id)
            .map((clip) => (
              <LayerChip
                key={clip.id}
                clip={clip}
                track={track}
                asset={assetById.get(clip.assetId)}
                mediaLoading={mediaLoading}
                zoom={zoom}
                selected={clip.id === selectedId || selectedIds.includes(clip.id)}
                blocked={blockedClipId === clip.id}
                onPointerDown={(event) => beginDrag(event, clip)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onTrim={(edge, value) =>
                  trimVideoClipEdge(clip.id, assetById.get(clip.assetId), edge, value)
                }
                onRemove={() => removeVideoClip(clip.id)}
                onToggleMute={() => setVideoClipAudio(clip.id, { muted: !clip.muted })}
              />
            ))}
        </div>
      ))}
    </div>
  )
}

function LayerChip({
  clip,
  track,
  asset,
  mediaLoading,
  zoom,
  selected,
  blocked,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onTrim,
  onRemove,
  onToggleMute,
}: {
  clip: VideoClip
  track: VideoTrack
  asset: Asset | undefined
  /** True while an asset absent from the library might still be on its way. */
  mediaLoading: boolean
  zoom: number
  selected: boolean
  blocked: boolean
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onTrim: (edge: 'start' | 'end', value: number) => void
  onRemove: () => void
  onToggleMute: () => void
}) {
  const trimRef = useRef<{ edge: 'start' | 'end'; startX: number; origin: number } | null>(null)
  const label = asset?.name ?? (mediaLoading ? 'media loading' : 'missing media')
  const isImage = asset?.kind === 'image'

  const beginTrim = (event: React.PointerEvent, edge: 'start' | 'end') => {
    event.preventDefault()
    // Without this the trim handle would also start the chip's own drag, and
    // the clip would slide along the lane as its edge was pulled.
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    trimRef.current = {
      edge,
      startX: event.clientX,
      origin: edge === 'start' ? clip.inPoint : clip.inPoint + clip.duration,
    }
  }

  const moveTrim = (event: React.PointerEvent) => {
    const state = trimRef.current
    if (!state) return
    event.stopPropagation()
    onTrim(state.edge, state.origin + (event.clientX - state.startX) / zoom)
  }

  const endTrim = (event: React.PointerEvent) => {
    if (!trimRef.current) return
    event.stopPropagation()
    trimRef.current = null
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      role="group"
      aria-label={`${label}, ${formatTime(clip.duration)} at ${formatTime(clip.startTime)} on ${track.name}`}
      // What a marquee sweeps for — see MARQUEE_MISSES in Timeline.
      data-clip-id={clip.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ left: clip.startTime * zoom, width: Math.max(30, clip.duration * zoom) }}
      className={`group/chip absolute top-0.5 bottom-0.5 flex cursor-grab items-center gap-1 overflow-hidden rounded border border-sky-600/40 bg-sky-500/15 px-1 text-[11px] text-sky-900 active:cursor-grabbing ${
        selected ? 'ring-2 ring-accent' : ''
      } ${blocked ? 'ring-2 ring-red-500' : ''} ${track.hidden ? 'opacity-40' : ''}`}
      title={
        blocked
          ? 'There is already a layer here — drop it somewhere with room.'
          : `${label} · ${formatTime(clip.duration)} at ${formatTime(clip.startTime)}`
      }
    >
      {asset ? (
        <AssetThumb asset={asset} className="h-full w-6 shrink-0 rounded-none border-0" />
      ) : (
        <span aria-hidden className="shrink-0 text-red-700">
          ⚠
        </span>
      )}
      <span className="truncate">{label}</span>

      <ClipMenu
        label={label}
        items={[
          ...(isImage
            ? []
            : [
                {
                  icon: clip.muted ? '🔊' : '🔇',
                  label: clip.muted ? 'Unmute this layer' : 'Mute this layer',
                  onSelect: onToggleMute,
                },
              ]),
          {
            icon: '🗑',
            label: `Remove ${label} from this lane`,
            note: 'Delete',
            onSelect: onRemove,
            danger: true,
          },
        ]}
        className="ml-auto size-4 shrink-0 opacity-70 transition hover:opacity-100"
      />

      {/* Trim handles, as on the picture track. A still has no in-point to
          move, so it gets only the one that changes how long it is held. */}
      {!isImage ? (
        <span
          role="slider"
          tabIndex={0}
          aria-label={`Trim the start of ${label}`}
          aria-valuenow={Math.round(clip.inPoint * 10) / 10}
          aria-valuemin={0}
          aria-valuemax={Math.round((clip.inPoint + clip.duration) * 10) / 10}
          onPointerDown={(event) => beginTrim(event, 'start')}
          onPointerMove={moveTrim}
          onPointerUp={endTrim}
          onPointerCancel={endTrim}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') onTrim('start', clip.inPoint - 0.1)
            if (event.key === 'ArrowRight') onTrim('start', clip.inPoint + 0.1)
          }}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-accent/0 transition group-hover/chip:bg-accent/70 focus-visible:bg-accent"
        />
      ) : null}

      <span
        role="slider"
        tabIndex={0}
        aria-label={isImage ? `Change how long ${label} is held` : `Trim the end of ${label}`}
        aria-valuenow={Math.round(clip.duration * 10) / 10}
        aria-valuemin={MIN_OVERLAY_DURATION}
        aria-valuemax={asset?.duration ?? 60}
        onPointerDown={(event) => beginTrim(event, 'end')}
        onPointerMove={moveTrim}
        onPointerUp={endTrim}
        onPointerCancel={endTrim}
        onKeyDown={(event) => {
          const end = clip.inPoint + clip.duration
          if (event.key === 'ArrowLeft') onTrim('end', end - 0.1)
          if (event.key === 'ArrowRight') onTrim('end', end + 0.1)
        }}
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-accent/0 transition group-hover/chip:bg-accent/70 focus-visible:bg-accent"
      />
    </div>
  )
}

/** The fixed left column: one header per video lane, aligned with the lanes. */
export function VideoTrackHeaders() {
  const tracks = useProjectStore((state) => videoTracksOf(state.project))
  const clips = useProjectStore((state) => videoClipsOf(state.project))
  const updateVideoTrack = useProjectStore((state) => state.updateVideoTrack)
  const moveVideoTrack = useProjectStore((state) => state.moveVideoTrack)
  const removeVideoTrack = useProjectStore((state) => state.removeVideoTrack)

  if (tracks.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-1">
      {[...tracks].reverse().map((track) => {
        const count = clips.filter((clip) => clip.trackId === track.id).length
        // Read off the array rather than off this reversed list, so that which
        // end of the stack a lane is at does not depend on the flip: the array
        // is bottom-first, so its last entry is the top of the stack.
        const atTop = tracks[tracks.length - 1]?.id === track.id
        const atBottom = tracks[0]?.id === track.id
        return (
          <div
            key={track.id}
            className="flex items-center gap-1.5 rounded bg-surface-2 px-2"
            style={{ height: VIDEO_LANE_HEIGHT }}
          >
            <button
              type="button"
              onClick={() => updateVideoTrack(track.id, { hidden: !track.hidden })}
              aria-pressed={track.hidden}
              aria-label={`${track.hidden ? 'Show' : 'Hide'} ${track.name}`}
              title={track.hidden ? 'Hidden — click to show' : 'Hide this lane'}
              className={`shrink-0 text-xs ${track.hidden ? 'opacity-40' : ''}`}
            >
              {track.hidden ? '🙈' : '🎬'}
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium" title={track.name}>
                {track.name}
              </p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={track.opacity}
                disabled={track.hidden}
                onChange={(event) =>
                  updateVideoTrack(track.id, { opacity: Number(event.target.value) })
                }
                aria-label={`${track.name} opacity`}
                title={`Opacity ${Math.round(track.opacity * 100)}%`}
                className="h-1 w-full"
              />
            </div>

            {/* Up and down the stack, which is what decides what covers what.
                The direction is the one thing here that is easy to get wrong:
                this list is drawn reversed so the top of the stack is at the
                top of the screen, so the button that moves a lane up the screen
                has to move it *later* in the array, not earlier. */}
            <div className="flex shrink-0 flex-col">
              <Button
                variant="ghost"
                className="!px-1 !py-0 text-[10px] leading-none"
                disabled={atTop}
                onClick={() => moveVideoTrack(track.id, 'up')}
                aria-label={`Move ${track.name} up`}
                title={
                  atTop
                    ? 'Already at the top of the stack'
                    : 'Move this lane up, over the one above it'
                }
              >
                ▲
              </Button>
              <Button
                variant="ghost"
                className="!px-1 !py-0 text-[10px] leading-none"
                disabled={atBottom}
                onClick={() => moveVideoTrack(track.id, 'down')}
                aria-label={`Move ${track.name} down`}
                title={
                  atBottom
                    ? 'Already at the bottom of the stack'
                    : 'Move this lane down, under the one below it'
                }
              >
                ▼
              </Button>
            </div>

            <Button
              variant="ghost"
              className="shrink-0 !px-1 !py-0 text-xs"
              onClick={() => {
                if (
                  count > 0 &&
                  !window.confirm(
                    `Delete "${track.name}" and its ${count} layer${count === 1 ? '' : 's'}?`,
                  )
                ) {
                  return
                }
                removeVideoTrack(track.id)
              }}
              aria-label={`Delete track ${track.name}`}
            >
              ✕
            </Button>
          </div>
        )
      })}
    </div>
  )
}
