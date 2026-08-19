/**
 * The audio half of the timeline: one lane per track, clips positioned by time.
 *
 * Clips can be dragged along the lane to retime them and up or down to move
 * between tracks of the same kind. A drag that would land on top of another
 * clip is refused rather than allowed to overlap, because two clips stacked on
 * one lane cannot both be heard and the mistake would only surface on export.
 */
import { useMemo, useRef, useState } from 'react'
import { Button } from './ui'
import { ClipMenu } from './ClipMenu'
import { WaveformCanvas } from './Waveform'
import { captionClipItem, type ClipMenuItem } from './clipMenuItems'
import { useAssetPeaks } from '../hooks/useAssetPeaks'
import { formatTime, snapToFrame } from '../lib/timeline'
import { audioCutTargetAt } from '../lib/audioTracks'
import { useAssetStore } from '../state/useAssetStore'
import { useCaptionJobStore } from '../state/useCaptionJobStore'
import { useProjectStore } from '../state/useProjectStore'
import type { CaptionTarget } from '../lib/captionSources'
import type { Asset, AudioClip, AudioTrack, AudioTrackKind } from '../lib/types'

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

/** Narrower than this and a chip has nothing left to grab or read. */
const MIN_CHIP_WIDTH = 30
/** The chip's own box: `top-1 bottom-1` inside the lane, and a 1px border. */
const CHIP_HEIGHT = LANE_HEIGHT - 8
const CHIP_BORDER = 1

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
  currentTime,
  targets,
}: {
  zoom: number
  /** Where the playhead is, which is where a cut from a clip's menu lands. */
  currentTime: number
  /** Which clips can be captioned, by clip id. Voice clips only — see `speechSources`. */
  targets: ReadonlyMap<string, CaptionTarget>
}) {
  const tracks = useProjectStore((state) => state.project.audioTracks)
  const clips = useProjectStore((state) => state.project.audioClips)
  const fps = useProjectStore((state) => state.project.fps)
  const moveAudioClipTo = useProjectStore((state) => state.moveAudioClipTo)
  const selectedId = useProjectStore((state) => state.selectedAudioClipId)
  const selectAudioClip = useProjectStore((state) => state.selectAudioClip)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)
  const cutAudioAt = useProjectStore((state) => state.cutAudioAt)

  const captionClip = useCaptionJobStore((state) => state.captionClip)
  const captioningClipId = useCaptionJobStore((state) => state.clipId)

  // The catalogue, so a chip can draw the sound it holds. Kept as a map here
  // rather than searched per chip, because a countdown lane alone can be
  // dozens of clips.
  const assets = useAssetStore((state) => state.assets)
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])

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

  // Snapped the same way the store snaps a cut, so a menu item offering to cut
  // and the cut it then makes cannot disagree at the very edges of a clip.
  const playhead = snapToFrame(currentTime, fps)

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
              asset={assetById.get(sourceOf(clip))}
              selected={clip.id === selectedId}
              blocked={blockedClipId === clip.id}
              target={targets.get(clip.id)}
              cuttable={audioCutTargetAt(clips, clip.id, playhead) !== null}
              captioning={captioningClipId === clip.id}
              onPointerDown={(event) => beginDrag(event, clip)}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onRemove={() => removeAudioClip(clip.id)}
              onCut={() => cutAudioAt(playhead, clip.id)}
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

/**
 * The asset a clip actually plays, which is what its waveform has to be drawn
 * from — the same choice playback and export make (see Preview and
 * lib/export/timelineRender).
 */
function sourceOf(clip: AudioClip): string {
  return clip.useConverted && clip.convertedAssetId ? clip.convertedAssetId : clip.assetId
}

function ClipChip({
  clip,
  track,
  zoom,
  asset,
  selected,
  blocked,
  target,
  cuttable,
  captioning,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
  onCut,
  onCaption,
}: {
  clip: AudioClip
  track: AudioTrack
  zoom: number
  /** What it plays. Absent while the catalogue is still loading. */
  asset: Asset | undefined
  selected: boolean
  blocked: boolean
  /** Set on a voice clip, which is the only kind with words to transcribe. */
  target: CaptionTarget | undefined
  /** Whether the playhead is somewhere a cut can actually land in this clip. */
  cuttable: boolean
  captioning: boolean
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onRemove: () => void
  onCut: () => void
  onCaption: (target: CaptionTarget) => void
}) {
  const tone = CLIP_TONE[track.kind]
  const label = clip.label ?? (clip.useConverted ? (clip.voiceName ?? 'Converted') : 'Your voice')
  const peaks = useAssetPeaks(asset)
  const width = Math.max(MIN_CHIP_WIDTH, clip.duration * zoom)

  const items: ClipMenuItem[] = [
    // Offered here as well as on the Cut button above, greyed rather than
    // hidden where the playhead is elsewhere: this menu is where somebody looks
    // to find out what a piece of audio can be told to do, and "cut it" is not
    // a thing anybody would guess a music bed could be told at all.
    {
      icon: '✂',
      label: 'Cut here',
      ...(cuttable ? { note: 'S' } : { note: 'park the playhead over this clip', disabled: true }),
      onSelect: onCut,
    },
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
      style={{ left: clip.startTime * zoom, width }}
      // `isolate` is what lets the waveform sit behind the name: it makes the
      // chip a stacking context, so the canvas's negative z-index puts it under
      // the text and over the chip's own tint rather than under the lane.
      className={`group/chip absolute top-1 bottom-1 isolate flex cursor-grab items-center gap-1 overflow-hidden rounded border px-2 text-[11px] transition-shadow active:cursor-grabbing ${tone} ${
        selected ? 'ring-2 ring-accent' : ''
      } ${blocked ? 'ring-2 ring-red-500' : ''} ${track.muted ? 'opacity-40' : ''}`}
      title={
        blocked
          ? 'There is already a clip here — drop it somewhere with room.'
          : `${label} · ${formatTime(clip.duration)}`
      }
    >
      {/* The clip's own sound, drawn across the chip rather than in a lane of
          its own: unlike a video clip's audio this *is* the clip, so it belongs
          where the clip is and moves with it when it is dragged. No label —
          the chip around it already has one, and a second name for the same
          thing is noise to read out.

          It inherits the chip's text colour, so voice, music and count-in each
          draw in their own kind's tone without a colour being named here. The
          width is the chip's inside, so a clip too short to be MIN_CHIP_WIDTH
          wide has its sound stretched over the chip it was widened to — a
          sliver either way, and the chip's left edge is still the truth about
          where it starts. */}
      {asset ? (
        <WaveformCanvas
          peaks={peaks}
          inPoint={clip.inPoint}
          duration={clip.duration}
          width={width - CHIP_BORDER * 2}
          height={CHIP_HEIGHT - CHIP_BORDER * 2}
          style={{ left: 0, top: 0 }}
          className="pointer-events-none absolute -z-10 opacity-50"
        />
      ) : null}

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
