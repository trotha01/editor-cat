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
import { ClipMenu } from './ClipMenu'
import { captionClipItem, type ClipMenuItem } from './clipMenuItems'
import { formatTime } from '../lib/timeline'
import { clipEnd } from '../lib/lanes'
import { SNAP_DISTANCE_PX, snapClipStart, snapPointsFor, withoutOwnEdges } from '../lib/snapping'
import { useCaptionJobStore } from '../state/useCaptionJobStore'
import { useProjectStore } from '../state/useProjectStore'
import type { CaptionTarget } from '../lib/captionSources'
import type { AudioClip, AudioTrack, AudioTrackKind } from '../lib/types'

export const LANE_HEIGHT = 44
/**
 * The `gap-1` between lanes, in pixels.
 *
 * Counted rather than ignored: a lane occupies its height *plus* this before
 * the next one starts, so a drag that divides by the height alone gains a lane
 * every eleventh one and drops the clip on the wrong track.
 */
const LANE_GAP = 4
const LANE_PITCH = LANE_HEIGHT + LANE_GAP
export const TRACK_GUTTER_WIDTH = 168

/** One colour per kind, so a lane says what it carries before you read it. */
const CLIP_TONE: Record<AudioTrackKind, string> = {
  voice: 'border-emerald-600/40 bg-emerald-500/15 text-emerald-900',
  music: 'border-violet-600/40 bg-violet-500/15 text-violet-900',
  countdown: 'border-amber-600/50 bg-amber-500/20 text-amber-900',
}

const KIND_ICON: Record<AudioTrackKind, string> = {
  voice: '🎙️',
  music: '🎵',
  countdown: '⏱️',
}

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
const LANE_SWITCH_THRESHOLD = LANE_PITCH * 0.6

export function AudioTrackLanes({
  zoom,
  targets,
}: {
  zoom: number
  /** Which clips can be captioned, by clip id. Voice clips only — see `speechSources`. */
  targets: ReadonlyMap<string, CaptionTarget>
}) {
  const project = useProjectStore((state) => state.project)
  const tracks = project.audioTracks
  const clips = project.audioClips
  const moveAudioClipTo = useProjectStore((state) => state.moveAudioClipTo)
  const selectedId = useProjectStore((state) => state.selectedAudioClipId)
  const selectAudioClip = useProjectStore((state) => state.selectAudioClip)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)

  const captionClip = useCaptionJobStore((state) => state.captionClip)
  const captioningClipId = useCaptionJobStore((state) => state.clipId)

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
      const laneDelta = Math.round(dy / LANE_PITCH)
      const candidate = tracks[originIndex + laneDelta]
      if (candidate?.kind === kind) targetTrackId = candidate.id
    }

    // Snapping is what makes the drag land flush against another clip's edge
    // instead of a pixel off it — the whole point of the feature, since a
    // voiceover a frame early or late from the shot it plays against is a bug
    // nobody would spot by eye until export.
    const rawStart = drag.originStart + dx / zoom
    const points = withoutOwnEdges(snapPointsFor(project), clip.startTime, clipEnd(clip))
    const start = snapClipStart(rawStart, clip.duration, points, SNAP_DISTANCE_PX / zoom)

    const ok = moveAudioClipTo(drag.clipId, start, targetTrackId)
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
              target={targets.get(clip.id)}
              captioning={captioningClipId === clip.id}
              onPointerDown={(event) => beginDrag(event, clip)}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onRemove={() => removeAudioClip(clip.id)}
              onCaption={(target) => void captionClip(target.source)}
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
  target,
  captioning,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
  onCaption,
}: {
  clip: AudioClip
  track: AudioTrack
  zoom: number
  selected: boolean
  blocked: boolean
  /** Set on a voice clip, which is the only kind with words to transcribe. */
  target: CaptionTarget | undefined
  captioning: boolean
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onRemove: () => void
  onCaption: (target: CaptionTarget) => void
}) {
  const tone = CLIP_TONE[track.kind]
  const label = clip.label ?? (clip.useConverted ? (clip.voiceName ?? 'Converted') : 'Your voice')

  const items: ClipMenuItem[] = [
    ...(target ? [captionClipItem(target, () => onCaption(target))] : []),
    { icon: '🗑', label: `Delete ${label}`, note: 'Delete', onSelect: onRemove, danger: true },
  ]

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
      <span aria-hidden>{KIND_ICON[track.kind]}</span>
      <span className="truncate">{label}</span>
      {/* Always drawn rather than revealed on hover. It costs a narrow chip a
          few pixels of its name, and buys the only way in to what this clip can
          be told to do — which, unlike a ✕, is not a thing you would guess at. */}
      <ClipMenu
        label={label}
        items={items}
        busy={captioning}
        className="ml-auto size-4 shrink-0 opacity-70 transition hover:opacity-100"
      />
    </div>
  )
}

/**
 * What a lane is for, and the control that changes it.
 *
 * A lane is added without being asked what it will carry, so this is where it
 * gets told. Only voice and music are offered: a countdown lane is made by
 * adding a count-in and turning one into a music bed would leave the beeps with
 * nowhere of their own to live.
 */
const SWITCHABLE: { kind: AudioTrackKind; label: string; hint: string }[] = [
  { kind: 'voice', label: '🎙️', hint: 'Voice — narration, at full level' },
  { kind: 'music', label: '🎵', hint: 'Music — a bed, mixed under the voices' },
]

function KindToggle({ track }: { track: AudioTrack }) {
  const setTrackKind = useProjectStore((state) => state.setTrackKind)

  // Nothing to switch between for a count-in lane, and offering the choice
  // would only raise a question with a bad answer.
  if (track.kind === 'countdown') return null

  return (
    <div
      role="radiogroup"
      aria-label={`What ${track.name} carries`}
      className="flex shrink-0 overflow-hidden rounded border border-line"
    >
      {SWITCHABLE.map((option) => {
        const selected = track.kind === option.kind
        return (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.hint}
            title={option.hint}
            onClick={() => setTrackKind(track.id, option.kind)}
            className={`px-1 py-0.5 text-[10px] transition-colors ${
              selected ? 'bg-accent text-accent-ink' : 'bg-surface text-ink-dim hover:text-ink'
            }`}
          >
            <span aria-hidden>{option.label}</span>
          </button>
        )
      })}
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
              {track.muted ? '🔇' : KIND_ICON[track.kind]}
            </button>

            {/* The name gets a line to itself. Sharing one with the kind
                toggle left every lane called "V…", which is a worse answer to
                "which lane is this" than the toggle was to "what is it for". */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium" title={track.name}>
                {track.name}
              </p>
              <div className="flex items-center gap-1.5">
                <KindToggle track={track} />
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={track.volume}
                  onChange={(event) =>
                    updateTrack(track.id, { volume: Number(event.target.value) })
                  }
                  aria-label={`${track.name} volume`}
                  title={`Volume ${Math.round(track.volume * 100)}%`}
                  className="h-1 min-w-0 flex-1"
                />
              </div>
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
