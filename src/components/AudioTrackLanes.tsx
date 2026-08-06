/**
 * The audio half of the timeline: one lane per track, clips positioned by time.
 *
 * Clips can be dragged along the lane to retime them and up or down to move
 * between tracks of the same kind. A drag that would land on top of another
 * clip is refused rather than allowed to overlap, because two clips stacked on
 * one lane cannot both be heard and the mistake would only surface on export.
 */
import { useRef, useState } from 'react'
import { Button } from './ui'
import { formatTime } from '../lib/timeline'
import { useProjectStore } from '../state/useProjectStore'
import type { AudioClip, AudioTrack } from '../lib/types'

export const LANE_HEIGHT = 44
export const TRACK_GUTTER_WIDTH = 150

interface DragState {
  clipId: string
  pointerId: number
  startX: number
  startY: number
  originStart: number
  originTrackId: string
  /** Set once the pointer has moved far enough to count as a drag. */
  moved: boolean
}

/** Vertical travel needed before a drag changes lanes, in pixels. */
const LANE_SWITCH_THRESHOLD = LANE_HEIGHT * 0.6

export function AudioTrackLanes({ zoom }: { zoom: number }) {
  const tracks = useProjectStore((state) => state.project.audioTracks)
  const clips = useProjectStore((state) => state.project.audioClips)
  const moveAudioClipTo = useProjectStore((state) => state.moveAudioClipTo)
  const selectedId = useProjectStore((state) => state.selectedAudioClipId)
  const selectAudioClip = useProjectStore((state) => state.selectAudioClip)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)

  const dragRef = useRef<DragState | null>(null)
  // The id of the clip whose drag is currently refused, kept in state rather
  // than read off the ref, because it drives what renders.
  const [blockedClipId, setBlockedClipId] = useState<string | null>(null)

  const beginDrag = (event: React.PointerEvent, clip: AudioClip) => {
    // Ignore secondary buttons so a right-click does not start a drag.
    if (event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    dragRef.current = {
      clipId: clip.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originStart: clip.startTime,
      originTrackId: clip.trackId,
      moved: false,
    }
    selectAudioClip(clip.id)
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

    const originIndex = tracks.findIndex((track) => track.id === drag.originTrackId)
    const kind = tracks[originIndex]?.kind

    // Only offer lanes of the same kind: a recording dropped into the music
    // bed would be mixed at the music track's gain, which is never intended.
    let targetTrackId = drag.originTrackId
    if (kind && Math.abs(dy) > LANE_SWITCH_THRESHOLD) {
      const laneDelta = Math.round(dy / LANE_HEIGHT)
      const candidate = tracks[originIndex + laneDelta]
      if (candidate?.kind === kind) targetTrackId = candidate.id
    }

    const ok = moveAudioClipTo(drag.clipId, drag.originStart + dx / zoom, targetTrackId)
    setBlockedClipId(ok ? null : drag.clipId)
  }

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setBlockedClipId(null)
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  if (tracks.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-1">
      {tracks.map((track) => (
        <div
          key={track.id}
          className={`relative rounded ${track.muted ? 'bg-surface-2/40' : 'bg-surface-2'}`}
          style={{ height: LANE_HEIGHT }}
        >
          {clipsFor(clips, track.id).map((clip) => (
            <ClipChip
              key={clip.id}
              clip={clip}
              track={track}
              zoom={zoom}
              selected={clip.id === selectedId}
              blocked={blockedClipId === clip.id}
              onPointerDown={(event) => beginDrag(event, clip)}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onRemove={() => removeAudioClip(clip.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function clipsFor(clips: readonly AudioClip[], trackId: string): AudioClip[] {
  return clips.filter((clip) => clip.trackId === trackId)
}

function ClipChip({
  clip,
  track,
  zoom,
  selected,
  blocked,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
}: {
  clip: AudioClip
  track: AudioTrack
  zoom: number
  selected: boolean
  blocked: boolean
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onRemove: () => void
}) {
  const isVoice = track.kind === 'voice'
  const tone = isVoice
    ? 'border-emerald-600/40 bg-emerald-500/15 text-emerald-900'
    : 'border-violet-600/40 bg-violet-500/15 text-violet-900'

  const label = clip.label ?? (clip.useConverted ? (clip.voiceName ?? 'Converted') : 'Your voice')

  return (
    <div
      role="group"
      aria-label={`${label}, ${formatTime(clip.duration)} at ${formatTime(clip.startTime)} on ${track.name}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ left: clip.startTime * zoom, width: Math.max(30, clip.duration * zoom) }}
      className={`group/chip absolute top-1 bottom-1 flex cursor-grab items-center gap-1 overflow-hidden rounded border px-2 text-[11px] transition-shadow active:cursor-grabbing ${tone} ${
        selected ? 'ring-2 ring-accent' : ''
      } ${blocked ? 'ring-2 ring-red-500' : ''} ${track.muted ? 'opacity-40' : ''}`}
      title={
        blocked
          ? 'There is already a clip here — drop it somewhere with room.'
          : `${label} · ${formatTime(clip.duration)}`
      }
    >
      <span aria-hidden>{isVoice ? '🎙️' : '🎵'}</span>
      <span className="truncate">{label}</span>
      <Button
        variant="ghost"
        // Hidden until hover: a short clip is only a few dozen pixels wide, and
        // a permanent button would leave no room for its name.
        className="ml-auto hidden shrink-0 !px-1 !py-0 group-hover/chip:inline-flex"
        onClick={onRemove}
        // The chip is a drag handle, so keep the delete button out of it.
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={`Delete ${label}`}
      >
        ✕
      </Button>
    </div>
  )
}

/** The fixed left column: one header per lane, aligned with the lanes. */
export function AudioTrackHeaders() {
  const tracks = useProjectStore((state) => state.project.audioTracks)
  const updateTrack = useProjectStore((state) => state.updateTrack)
  const removeTrack = useProjectStore((state) => state.removeTrack)
  const clips = useProjectStore((state) => state.project.audioClips)

  if (tracks.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-1">
      {tracks.map((track) => {
        const count = clipsFor(clips, track.id).length
        return (
          <div
            key={track.id}
            className="flex items-center gap-1.5 rounded bg-surface-2 px-2"
            style={{ height: LANE_HEIGHT }}
          >
            <button
              type="button"
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
              aria-pressed={track.muted}
              aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
              title={track.muted ? 'Muted — click to unmute' : 'Mute this track'}
              className={`shrink-0 text-xs ${track.muted ? 'opacity-40' : ''}`}
            >
              {track.muted ? '🔇' : track.kind === 'voice' ? '🎙️' : '🎵'}
            </button>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium" title={track.name}>
                {track.name}
              </p>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={track.volume}
                onChange={(event) => updateTrack(track.id, { volume: Number(event.target.value) })}
                aria-label={`${track.name} volume`}
                title={`Volume ${Math.round(track.volume * 100)}%`}
                className="h-1 w-full"
              />
            </div>

            <Button
              variant="ghost"
              className="shrink-0 !px-1 !py-0 text-xs"
              onClick={() => {
                if (
                  count > 0 &&
                  !window.confirm(
                    `Delete "${track.name}" and its ${count} clip${count === 1 ? '' : 's'}?`,
                  )
                ) {
                  return
                }
                removeTrack(track.id)
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
