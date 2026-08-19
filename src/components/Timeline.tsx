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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { AudioFixStatus } from './AudioFixStatus'
import { CaptionJobStatus } from './CaptionJobStatus'
import { ClipMenu } from './ClipMenu'
import { ClipReadinessBar } from './ClipReadinessBar'
import { FixAudioDialog } from './FixAudioDialog'
import { captionClipItem, fixAudioItem, type ClipMenuItem } from './clipMenuItems'
import {
  MAX_LEAD_IN,
  MIN_CLIP_DURATION,
  clamp,
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
  zoomFromPinch,
} from '../lib/timeline'
import { audioCutTargetAt, audioCutTargetsAt, audioEnd } from '../lib/audioTracks'
import { transitionRoomAt } from '../lib/transitions'
import { videoClipsOf, videoLayersEnd } from '../lib/videoTracks'
import { captionCuesOf, captionsEnd } from '../lib/captions'
import { captionTargets, type CaptionTarget } from '../lib/captionSources'
import { fixTargets, type FixTarget } from '../lib/clipAudioFix'
import { isTypingTarget } from '../lib/shortcuts'
import { boxFromCorners, boxesOverlap, isMarqueeDrag, type Box } from '../lib/marquee'
import { AudioTrackHeaders, AudioTrackLanes, TRACK_GUTTER_WIDTH } from './AudioTrackLanes'
import { VideoTrackHeaders, VideoTrackLanes } from './VideoTrackLanes'
import { CaptionLanes, CaptionTrackHeaders } from './CaptionLanes'
import { TransitionMarker } from './TransitionMarker'
import { ClipWaveformLane, WAVEFORM_LANE_HEIGHT, type WaveformEntry } from './ClipWaveforms'
import { useAssetStore } from '../state/useAssetStore'
import { useAudioFixStore } from '../state/useAudioFixStore'
import { useCaptionJobStore } from '../state/useCaptionJobStore'
import { useProjectStore } from '../state/useProjectStore'
import { useProjectsStore } from '../state/useProjectsStore'
import { canUseElevenLabs, useSettingsStore } from '../state/useSettingsStore'
import type { Asset, Clip, PositionedClip } from '../lib/types'

/**
 * Narrowest a clip card may be drawn. Below this a short clip has no room for
 * its trim handles, let alone its menu, so it is drawn wider than its time —
 * the one place on this track where a pixel is not a fixed number of seconds.
 */
const MIN_CARD_WIDTH = 36

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
  mediaLoading,
  zoom,
  width,
  pull,
  selected,
  cutAtStart,
  target,
  fixTarget,
  canFixAudio,
  captioning,
  fixing,
  onSelect,
  onTrim,
  onRemove,
  onJoin,
  onCaption,
  onFixAudio,
  onToggleMute,
}: {
  entry: PositionedClip
  asset: Asset | undefined
  /**
   * True while this project's media is still being restored from storage, so an
   * asset that has not shown up in the library yet is still on its way rather
   * than gone.
   */
  mediaLoading: boolean
  zoom: number
  /** Drawn width, which has a floor so a very short clip stays clickable. */
  width: number
  /** How far this card is pulled back over the one before it, in pixels. */
  pull: number
  selected: boolean
  /** True when this clip carries on from the one before it — i.e. a cut. */
  cutAtStart: boolean
  /** Set when this clip has speech worth transcribing. Absent for a still. */
  target: CaptionTarget | undefined
  /** Set when this clip carries sound that could be said again. */
  fixTarget: FixTarget | undefined
  /** Whether the voice features can run: this site's key, or the user's own. */
  canFixAudio: boolean
  captioning: boolean
  /** True while this clip's line is being said again. */
  fixing: boolean
  onSelect: () => void
  onTrim: (edge: 'start' | 'end', seconds: number) => void
  onRemove: () => void
  onJoin: () => void
  onCaption: (target: CaptionTarget) => void
  onFixAudio: (target: FixTarget) => void
  onToggleMute: () => void
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

  const isImage = asset?.kind === 'image'
  const name = asset?.name ?? 'this clip'
  const silent = asset?.kind === 'video' && clipGain(entry.clip) <= 0

  const items: ClipMenuItem[] = [
    ...(target ? [captionClipItem(target, () => onCaption(target))] : []),
    // Offered greyed out rather than left out, because "why can I not caption
    // this one" has an answer here and nowhere else on the timeline.
    ...(silent
      ? [
          {
            icon: '💬',
            label: 'Generate captions for this clip',
            note: 'muted',
            onSelect: () => {},
            disabled: true,
          },
        ]
      : []),
    // Under the caption row on purpose: the captions are where the words come
    // from, so "read what it said, then fix how it said it" reads down the menu
    // in the order it is done.
    ...(fixTarget ? [fixAudioItem(fixTarget, canFixAudio, () => onFixAudio(fixTarget))] : []),
    ...(isImage
      ? []
      : [
          {
            icon: entry.clip.muted ? '🔊' : '🔇',
            label: entry.clip.muted ? 'Unmute this clip’s sound' : 'Mute this clip’s sound',
            onSelect: onToggleMute,
          },
        ]),
    // The only way to put a cut back. The dashed line on the clip says one is
    // there; this is the version that says what can be done about it, and it is
    // here rather than in the seam because the seam belongs to the transition
    // mark — two controls a few pixels apart, one adding a blend and the other
    // undoing an edit, is a mis-click waiting to happen.
    ...(cutAtStart
      ? [
          {
            icon: '✂',
            label: 'Undo the cut before this clip',
            onSelect: onJoin,
          },
        ]
      : []),
    {
      icon: '🗑',
      label: 'Remove clip from the timeline',
      note: 'Delete',
      onSelect: onRemove,
      danger: true,
    },
  ]

  return (
    <div
      ref={setNodeRef}
      // What the marquee sweeps for, and what tells it this press was on a clip
      // rather than on the empty timeline behind one.
      data-clip-id={entry.clip.id}
      style={{
        width,
        // A transition is an overlap, so the card really does sit on top of the
        // one before it — a negative margin is what puts a clip's card where its
        // start time is once that start has been pulled back.
        marginLeft: pull > 0 ? -pull : undefined,
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      className={`group relative h-20 shrink-0 overflow-hidden rounded-lg border bg-surface-2 ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'
      }`}
    >
      {/* The stretch this clip shares with the one underneath, marked on the
          card that is covering it up. Without it the overlap reads as a clip
          drawn in the wrong place. */}
      {pull > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 border-r border-accent/60 bg-gradient-to-r from-accent/45 to-transparent"
          style={{ width: pull }}
        />
      ) : null}

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
        ) : mediaLoading ? (
          <span className="flex size-full items-center justify-center text-xs text-ink-dim">
            media loading
          </span>
        ) : (
          <span className="flex size-full items-center justify-center text-xs text-red-700">
            media missing
          </span>
        )}
      </button>

      {/* How much of this clip is loaded, drawn along its own top edge so the
          whole track reads as one bar: where it is green, playback will hold. */}
      <ClipReadinessBar clipId={entry.clip.id} />

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

      {/* Always drawn, not revealed on hover: it is the way in to everything a
          clip can be told to do, and one you have to know is there is not. */}
      <ClipMenu
        label={name}
        items={items}
        busy={captioning || fixing}
        className="absolute top-1 right-1 size-5 bg-black/70 text-xs text-white opacity-80 transition hover:opacity-100"
      />

      {/* A cut you made, still here because the two halves are still two clips.
          A line and nothing else: the seam already has one control in it, the
          transition mark, and a second button in the same few pixels doing
          something entirely different is how you undo a cut by accident.
          Joining the halves back up is on this clip's ⋯ menu, which is where
          everything else a clip can be told to do lives. */}
      {cutAtStart ? (
        <span
          role="img"
          aria-label={`Cut at ${formatTime(entry.start)}`}
          title={`Cut at ${formatTime(entry.start)} — undo it from this clip’s ⋯ menu`}
          className="pointer-events-none absolute inset-y-0 left-0 border-l-2 border-dashed border-accent"
        />
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

/**
 * One edge of the marked export range.
 *
 * Drawn the full height of the timeline, not just the ruler, so it stays
 * grabbable wherever the pointer happens to be — over the clips, the audio
 * lanes, anywhere. Only this narrow strip takes the pointer; the highlighted
 * band it bounds does not, so everything under it is still reachable exactly
 * as it was.
 */
function ExportRangeHandle({
  seconds,
  zoom,
  label,
  onChange,
}: {
  seconds: number
  zoom: number
  label: string
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

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={Math.round(seconds * 10) / 10}
      title={`${label} — ${formatTime(Math.max(0, seconds))}`}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onChange(seconds - 0.1)
        if (event.key === 'ArrowRight') onChange(seconds + 0.1)
      }}
      style={{ left: seconds * zoom }}
      className="pointer-events-auto absolute top-0 bottom-0 z-20 w-2 -translate-x-1/2 cursor-ew-resize bg-accent/70 transition hover:bg-accent focus-visible:bg-accent"
    />
  )
}

/**
 * How tall a row of the gutter that adds a lane is.
 *
 * A number rather than a class because the lanes column has to hold a spacer of
 * exactly this height opposite each one. Nothing lines the two columns up but
 * their rows being the same height — a row on one side with nothing facing it
 * puts every lane below it out of line with its own header.
 */
const ADD_TRACK_ROW_HEIGHT = 28

/**
 * The button that adds a lane, in the gutter beside where that lane will turn
 * up: video above the picture it lays over, audio below the clip sound it is
 * mixed with. Here rather than in the header above the timeline because adding
 * a track is a thing you do to a place, and this is the place — the button sits
 * in the gap the new lane opens up.
 */
function AddTrackRow({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <div className="mt-2 flex" style={{ height: ADD_TRACK_ROW_HEIGHT }}>
      <Button
        variant="ghost"
        onClick={onClick}
        title={title}
        className="h-full w-full border border-dashed border-line !px-2 !py-0 text-[11px]"
      >
        {label}
      </Button>
    </div>
  )
}

/** The lanes-column counterpart to an `AddTrackRow`, holding its line open. */
function AddTrackSpacer() {
  return <div aria-hidden className="mt-2" style={{ height: ADD_TRACK_ROW_HEIGHT }} />
}

/**
 * What a press must have missed for it to be the start of a marquee.
 *
 * Everything listed here owns its own drag — a clip card or chip, the ruler
 * that doubles as the scrub bar, a trim or export handle, a menu button, a
 * slider — so a press that landed on one is that thing's press and not a band.
 * Captions need no entry: their own drags stop the event before it gets here.
 *
 * Read off the event's target rather than settled by stacking order, because
 * what is on top at a given pixel is a layout question and this is not: the
 * empty stretch between two chips on a lane is background whatever is drawn
 * over the lane, and the two pixels of a card under a transition marker are
 * still the card.
 */
const MARQUEE_MISSES = '[data-clip-id], [role="presentation"], [role="slider"], button, input'

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
  // Read alongside the picture track's own selection so one Delete-key
  // handler below can cover every lane, not just this one.
  const selectedVideoClipId = useProjectStore((state) => state.selectedVideoClipId)
  const removeVideoClip = useProjectStore((state) => state.removeVideoClip)
  const selectedAudioClipId = useProjectStore((state) => state.selectedAudioClipId)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)
  // The marquee's group, which Delete and a group drag both act on.
  const selectedIds = useProjectStore((state) => state.selectedIds)
  const selectMany = useProjectStore((state) => state.selectMany)
  const removeClips = useProjectStore((state) => state.removeClips)
  const moveClips = useProjectStore((state) => state.moveClips)
  const trim = useProjectStore((state) => state.trim)
  const cutAt = useProjectStore((state) => state.cutAt)
  const cutAudioAt = useProjectStore((state) => state.cutAudioAt)
  const cutEverythingAt = useProjectStore((state) => state.cutEverythingAt)
  const removeCut = useProjectStore((state) => state.removeCut)
  const exportRange = useProjectStore((state) => state.exportRange)
  const setExportRange = useProjectStore((state) => state.setExportRange)
  const markExportStart = useProjectStore((state) => state.markExportStart)
  const markExportEnd = useProjectStore((state) => state.markExportEnd)
  const setTransition = useProjectStore((state) => state.setTransition)
  const setAllTransitions = useProjectStore((state) => state.setAllTransitions)
  const assets = useAssetStore((state) => state.assets)
  const assetsLoading = useAssetStore((state) => state.loading)
  const hydrating = useProjectsStore((state) => state.hydration !== null)
  // While either of these is true, a clip whose asset has not shown up yet is
  // still on its way rather than actually gone — the library's own first load
  // and a project's media coming back from storage both leave a gap here before
  // the asset appears.
  const mediaLoading = assetsLoading || hydrating

  const setClipAudio = useProjectStore((state) => state.setClipAudio)

  const addTrack = useProjectStore((state) => state.addTrack)
  const addVideoTrack = useProjectStore((state) => state.addVideoTrack)
  const setLeadIn = useProjectStore((state) => state.setLeadIn)

  const captionClip = useCaptionJobStore((state) => state.captionClip)
  const captioningClipId = useCaptionJobStore((state) => state.clipId)

  const fixingClipId = useAudioFixStore((state) => state.clipId)
  const canFixAudio = useSettingsStore(canUseElevenLabs)
  // Which clip the fix dialog is about. Held here rather than in the dialog
  // because the menu that opens it is inside a card that re-renders constantly,
  // and the dialog outlives the menu — the menu closes on the click.
  const [fixingTarget, setFixingTarget] = useState<FixTarget | null>(null)

  const [zoom, setZoom] = useState(40)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const leadIn = leadInOf(project)
  const positioned = useMemo(() => layoutClips(project.clips, leadIn), [project.clips, leadIn])
  const visualDuration = totalDuration(project.clips)
  const pictureEndTime = leadIn + visualDuration
  const audioEndTime = audioEnd(project.audioClips)
  // What the export dialog calls `outputDuration` — the picture or the sound,
  // whichever runs longer. Marking a range against this rather than the
  // picture track alone is what keeps "End" reachable on a project that is
  // carried by a voiceover running past the last clip.
  const exportDuration = Math.max(pictureEndTime, audioEndTime)

  // Where each card really lands, which is not simply its start times a zoom:
  // a card has a floor on its width so a very short clip stays clickable, and
  // the row is laid out by the flexbox rather than by these numbers. Worked out
  // once, here, because the marks between the cards are positioned absolutely
  // and have to agree with where the cards ended up to the pixel.
  const cards = useMemo(() => {
    const laid: {
      entry: PositionedClip
      width: number
      pull: number
      left: number
      /** The longest transition this clip's own boundary could hold. */
      room: number
    }[] = []
    let cursor = leadIn * zoom
    for (const entry of positioned) {
      const width = Math.max(MIN_CARD_WIDTH, entry.duration * zoom)
      // Never pull a card entirely behind its neighbour: an overlap you cannot
      // see past is a clip with nothing left of it to grab.
      const pull = Math.min(
        (entry.transition?.duration ?? 0) * zoom,
        Math.max(0, width - MIN_CARD_WIDTH),
      )
      const left = cursor - pull
      cursor = left + width
      // Worked out here rather than per mark, because this runs when the clips
      // change and the marks are rendered on every frame the playhead moves.
      laid.push({ entry, width, pull, left, room: transitionRoomAt(project.clips, entry.index) })
    }
    return laid
  }, [positioned, project.clips, zoom, leadIn])

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

  // Which clips can be captioned, and what each already has. Worked out once
  // for the whole timeline rather than per clip: it is a join across the audio
  // tracks, the picture track and every cue, and both lanes ask the same
  // question of it.
  const targets = useMemo(() => captionTargets(project, assets), [project, assets])

  // The same question for the other thing a clip's sound can have done to it.
  // A separate join because it answers differently: a clip that has already been
  // silenced is out of the captioning list and still very much in this one —
  // silencing it is what fixing it did.
  const fixable = useMemo(() => fixTargets(project, assets), [project, assets])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Where a cut would land, and whether one can land there at all. Recomputed
  // as the playhead moves, so the button says what pressing it would do.
  const cutTarget = useMemo(
    () => cutTargetAt(project.clips, currentTime, project.fps, leadIn),
    [project.clips, currentTime, project.fps, leadIn],
  )

  // The same question of the sound, asked only of the clip that is selected.
  // Selecting one is how you say which of the lanes sounding at that moment you
  // meant — with none selected the button belongs to the picture, as it always
  // did, rather than cutting a music bed somebody had merely scrolled past.
  const audioCutTarget = useMemo(
    () =>
      audioCutTargetAt(
        project.audioClips,
        selectedAudioClipId,
        snapToFrame(currentTime, project.fps),
      ),
    [project.audioClips, selectedAudioClipId, currentTime, project.fps],
  )

  // Every audio clip a cut would land on, asked with none named in particular —
  // only meaningful with nothing selected, which is the one case where "no
  // clip in particular" means "every one under the playhead" rather than "the
  // picture, as if the others weren't there."
  const audioCutTargets = useMemo(
    () => audioCutTargetsAt(project.audioClips, snapToFrame(currentTime, project.fps)),
    [project.audioClips, currentTime, project.fps],
  )

  // Both tracks behind one button and one key. A selection names one lane in
  // particular, so that clip alone is cut, falling through to the picture
  // exactly as before when the store refuses a cut it cannot make there. With
  // nothing named, "no clip in particular" takes every lane the playhead sits
  // over — picture and every bed at once, as one edit.
  const cut = useCallback(
    (time: number) => {
      if (selectedAudioClipId) {
        if (!cutAudioAt(time)) cutAt(time)
        return
      }
      cutEverythingAt(time)
    },
    [cutAudioAt, cutAt, cutEverythingAt, selectedAudioClipId],
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
      // Leave the browser's own Ctrl/Cmd-S and friends alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        // Already a no-op where nothing can be cut, so it needs no guard here.
        cut(playheadRef.current)
      } else if (event.key === 'i' || event.key === 'I') {
        // In point, same letter editors from Premiere to iMovie use for it.
        event.preventDefault()
        markExportStart(playheadRef.current, exportDuration)
      } else if (event.key === 'o' || event.key === 'O') {
        event.preventDefault()
        markExportEnd(playheadRef.current)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cut, markExportStart, markExportEnd, exportDuration])

  // Picture, overlay video and audio clips each keep their own selection, so
  // this checks all three rather than just the picture track's — Delete is
  // expected to work on whichever clip is currently highlighted, wherever it
  // lives on the timeline. A marquee's group comes first and covers every lane
  // at once, which is the whole point of having swept one up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (isTypingTarget(event.target)) return
      if (selectedIds.length > 0) {
        event.preventDefault()
        removeClips(selectedIds)
      } else if (selectedClipId) {
        event.preventDefault()
        removeClip(selectedClipId)
      } else if (selectedVideoClipId) {
        event.preventDefault()
        removeVideoClip(selectedVideoClipId)
      } else if (selectedAudioClipId) {
        event.preventDefault()
        removeAudioClip(selectedAudioClipId)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedIds,
    removeClips,
    selectedClipId,
    removeClip,
    selectedVideoClipId,
    removeVideoClip,
    selectedAudioClipId,
    removeAudioClip,
  ])

  const framePx = framePixels(zoom, project.fps)
  const frameLines = framePx >= MIN_FRAME_LINE_PX
  const canReachFrames = framePixels(MAX_ZOOM, project.fps) >= MIN_FRAME_LINE_PX

  const nothingToCutTitle = clipAtTime(project.clips, currentTime, leadIn)
    ? `Too close to the edge of this clip — a cut has to leave ${MIN_CLIP_DURATION}s on both sides.`
    : 'Park the playhead over a clip to cut it, or select an audio clip to cut that instead.'

  const cutTitle = selectedAudioClipId
    ? audioCutTarget
      ? `Cut the selected audio clip at ${formatTime(snapToFrame(currentTime, project.fps))} (S)`
      : cutTarget
        ? `Cut at ${formatTime(snapToFrame(currentTime, project.fps))} (S)`
        : nothingToCutTitle
    : cutTarget || audioCutTargets.length > 0
      ? `Cut everything at ${formatTime(snapToFrame(currentTime, project.fps))} (S)`
      : nothingToCutTitle

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      // Picking up one clip of a group carries the whole group, in the order it
      // is already in. Reordering is all "moving" means on a track laid end to
      // end, so this is what moving a group together is here.
      const run = project.clips
        .filter((clip) => selectedIds.includes(clip.id))
        .map((clip) => clip.id)
      if (run.length > 1 && run.includes(String(active.id))) {
        moveClips(run, String(over.id))
        return
      }
      const from = project.clips.findIndex((clip) => clip.id === active.id)
      const to = project.clips.findIndex((clip) => clip.id === over.id)
      if (from >= 0 && to >= 0) moveClip(from, to)
    },
    [project.clips, moveClip, moveClips, selectedIds],
  )

  // Where to re-anchor the scroll position once a pinch changes the zoom,
  // filled in by onWheelZoom and consumed by the layout effect below. It has
  // to wait for that effect because the scrollable content is only as wide as
  // the zoom that is about to replace this one — setting scrollLeft before the
  // resize lands just gets clamped back by the browser.
  const pinchAnchor = useRef<{ pointerX: number; secondsAtPointer: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = pinchAnchor.current
    const container = scrollRef.current
    if (!anchor || !container) return
    pinchAnchor.current = null
    container.scrollLeft = anchor.secondsAtPointer * zoom - anchor.pointerX
  }, [zoom])

  // A trackpad pinch has no event of its own on the web — browsers report it as
  // a wheel event with ctrlKey set, which is also what an actual Ctrl+wheel
  // looks like, so this catches both for free. preventDefault stops it from
  // also zooming the whole page.
  const onWheelZoom = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    const container = scrollRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    // The instant under the cursor, so it is what stays under the cursor once
    // the zoom changes — without this a pinch in the middle of a long timeline
    // sends the picture sliding out from under your fingers.
    pinchAnchor.current = { pointerX, secondsAtPointer: (container.scrollLeft + pointerX) / zoom }
    // Pinch deltaY is negative when spreading fingers apart, same sign as
    // scrolling up, so this reads as zoom in.
    setZoom(zoomFromPinch(zoom, event.deltaY, MIN_ZOOM, MAX_ZOOM))
  }

  const scrubAt = useCallback(
    (clientX: number) => {
      const ruler = trackRef.current
      if (!ruler) return
      // The ruler moves with the scroll container, so its own bounding box
      // already accounts for the scroll offset.
      const rect = ruler.getBoundingClientRect()
      // Snapped, so the playhead parks on a frame line rather than a pixel — the
      // cut is going to land on one of those anyway, and it should land on the
      // one you clicked.
      onSeek(snapToFrame((clientX - rect.left) / zoom, project.fps))
    },
    [onSeek, zoom, project.fps],
  )

  // Pointer capture, same as the trim handles above, so the drag keeps
  // tracking the playhead even once the cursor has left the thin ruler strip
  // — which it will, the moment you drag down towards the clips.
  const beginScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubAt(event.clientX)
  }

  const moveScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    scrubAt(event.clientX)
  }

  const endScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  // Where the band started, and whether it has yet travelled far enough to be a
  // band at all rather than a click on the background.
  const marqueeRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  // In the lanes column's own coordinates, so it can be drawn straight into it.
  const [band, setBand] = useState<Box | null>(null)

  /**
   * Which clips the band is over.
   *
   * Read off where the cards and chips actually are rather than worked out from
   * times and lane heights, because those are two different questions once a
   * card has been floored to a minimum width or pulled back over its neighbour
   * by a transition — and a second copy of the layout is a second thing to get
   * wrong. The elements already know; this only has to ask them.
   */
  const sweep = useCallback(
    (box: Box, origin: DOMRect) => {
      const lanes = lanesRef.current
      if (!lanes) return
      const ids: string[] = []
      for (const node of lanes.querySelectorAll<HTMLElement>('[data-clip-id]')) {
        const rect = node.getBoundingClientRect()
        const over = boxesOverlap(box, {
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          right: rect.right - origin.left,
          bottom: rect.bottom - origin.top,
        })
        if (over && node.dataset.clipId) ids.push(node.dataset.clipId)
      }
      selectMany(ids)
    },
    [selectMany],
  )

  const beginMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest(MARQUEE_MISSES)) return
    // Captured, so the band keeps growing once the pointer leaves the lanes —
    // which it does the moment you sweep past the last one.
    event.currentTarget.setPointerCapture(event.pointerId)
    marqueeRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    }
  }

  const moveMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const marquee = marqueeRef.current
    if (!marquee || marquee.pointerId !== event.pointerId) return
    const origin = event.currentTarget.getBoundingClientRect()
    const box = boxFromCorners(
      marquee.clientX - origin.left,
      marquee.clientY - origin.top,
      event.clientX - origin.left,
      event.clientY - origin.top,
    )
    // Nothing is swept until the press has become a drag, so a click that
    // wobbles a pixel still reads as a click.
    if (!band && !isMarqueeDrag(box)) return
    setBand(box)
    sweep(box, origin)
  }

  const endMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const marquee = marqueeRef.current
    if (!marquee) return
    marqueeRef.current = null
    // A press that never became a band is a click on the empty timeline, which
    // is how you let go of everything — including a single clip's selection,
    // since there is nowhere else on screen that says "none of these".
    if (!band) selectMany([])
    setBand(null)
    const target = event.currentTarget
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const playheadX = currentTime * zoom
  // The lanes must span the audio and the captions too — a music bed longer
  // than the picture still has to be reachable and scrubbable, and a caption
  // dragged past the end has to stay visible enough to drag back.
  const contentWidth =
    Math.max(
      pictureEndTime,
      audioEndTime,
      // Layers too. A layer held past everything else would otherwise fall off
      // the end of the scrollable area — drawn, but out where it cannot be
      // reached to be dragged back.
      videoLayersEnd(videoClipsOf(project)),
      captionsEnd(captionCuesOf(project)),
    ) * zoom

  // Fitted to the timeline as it stands, same as the export dialog fits it
  // before rendering — a range left over from a longer edit is drawn against
  // what is actually there rather than running off the end of it.
  const rangeStart = exportRange ? clamp(exportRange.start, 0, exportDuration) : null
  const rangeEnd = exportRange ? clamp(exportRange.end, rangeStart ?? 0, exportDuration) : null

  // Never shrinks. Beside the panels the preview above is what gives way to make
  // room, because a timeline squeezed to a few pixels is not a timeline, and
  // this is the half of the screen the work happens in.
  return (
    <section className="flex shrink-0 flex-col gap-2" aria-label="Timeline">
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
          {/* Only what an export would actually cut — a range fitted back to
              covering the whole thing is the same as no range at all. */}
          {rangeStart !== null && rangeEnd !== null && (rangeStart > 0 || rangeEnd < exportDuration)
            ? ` · export ${formatTime(rangeStart)}–${formatTime(rangeEnd)}`
            : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            onClick={() => cut(currentTime)}
            disabled={
              selectedAudioClipId
                ? !cutTarget && !audioCutTarget
                : !cutTarget && audioCutTargets.length === 0
            }
            title={cutTitle}
          >
            <span aria-hidden>✂</span> Cut
          </Button>
          {/* Marks where an export of the timeline starts or ends, at the
              playhead — the direct way to choose one, versus typing seconds
              into the export dialog, which now opens onto whatever is marked
              here. */}
          <Button
            onClick={() => markExportStart(currentTime, exportDuration)}
            title="Mark where an export of this timeline starts, at the playhead (I)"
          >
            <span aria-hidden>[</span> Start
          </Button>
          <Button
            onClick={() => markExportEnd(currentTime)}
            title="Mark where an export of this timeline ends, at the playhead (O)"
          >
            <span aria-hidden>]</span> End
          </Button>
          {exportRange ? (
            <Button
              variant="ghost"
              onClick={() => setExportRange(null)}
              title="Export the whole video again"
            >
              Clear range
            </Button>
          ) : null}
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

          {/* Video lanes lay over the picture, so their headers sit over the
              picture's own in the gutter too — the stacking order the lanes
              draw in, read top to bottom. */}
          <VideoTrackHeaders />

          <AddTrackRow
            label="+ Video track"
            title="Add an empty video track. Clips on it are laid over the picture rather than into it."
            onClick={addVideoTrack}
          />

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

          {/* One button, because a voice lane and a music lane are both audio
              lanes — what a lane carries is set on the lane itself, where you
              can also change your mind about it later. */}
          <AddTrackRow
            label="+ Audio track"
            title="Add an empty audio track. Switch it between voice and music from the lane itself."
            onClick={() => addTrack('voice')}
          />

          <AudioTrackHeaders />

          <CaptionTrackHeaders />
        </div>

        <div
          ref={scrollRef}
          onWheel={onWheelZoom}
          className="min-w-0 flex-1 overflow-x-auto p-3 pl-2"
        >
          {/* The whole lanes column takes the press, so a band can be swept from
              any empty stretch of it — between two chips, past the end of the
              picture, or across the gap under a lane. What the press must have
              missed to count as a band is MARQUEE_MISSES. */}
          <div
            ref={lanesRef}
            onPointerDown={beginMarquee}
            onPointerMove={moveMarquee}
            onPointerUp={endMarquee}
            onPointerCancel={endMarquee}
            className="relative min-w-full"
            style={{ width: Math.max(contentWidth, 320) }}
          >
            {/* Ruler doubles as the scrub bar, and carries the frame grid: the
                lines run straight down into the picture track below, so the
                playhead can be parked on the frame you mean to cut. */}
            <div
              ref={trackRef}
              onPointerDown={beginScrub}
              onPointerMove={moveScrub}
              onPointerUp={endScrub}
              onPointerCancel={endScrub}
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

            {/* Above the picture it is laid over, matching the headers in the
                gutter: the lanes read up the screen in the order they stack in. */}
            <VideoTrackLanes zoom={zoom} />

            {/* Facing "+ Video track" over in the gutter. */}
            <AddTrackSpacer />

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
                    {cards.length === 0 ? (
                      <p className="px-2 py-6 text-sm text-ink-dim">
                        Nothing on the timeline yet. Add a clip from the Library.
                      </p>
                    ) : (
                      cards.map(({ entry, width, pull }) => (
                        <ClipCard
                          key={entry.clip.id}
                          entry={entry}
                          asset={assetById.get(entry.clip.assetId)}
                          mediaLoading={mediaLoading}
                          zoom={zoom}
                          width={width}
                          pull={pull}
                          selected={
                            entry.clip.id === selectedClipId || selectedIds.includes(entry.clip.id)
                          }
                          cutAtStart={cutBefore(positioned, entry.index)}
                          target={targets.get(entry.clip.id)}
                          fixTarget={fixable.get(entry.clip.id)}
                          canFixAudio={canFixAudio}
                          captioning={captioningClipId === entry.clip.id}
                          fixing={fixingClipId === entry.clip.id}
                          // A clip already in a group keeps the group: picking
                          // it up is how the group gets dragged, and narrowing
                          // to the one clip would throw away the very selection
                          // being moved.
                          onSelect={() => {
                            if (!selectedIds.includes(entry.clip.id)) selectClip(entry.clip.id)
                          }}
                          onTrim={(edge, seconds) =>
                            trim(entry.clip.id, assetById.get(entry.clip.assetId), edge, seconds)
                          }
                          onRemove={() => removeClip(entry.clip.id)}
                          onJoin={() => removeCut(entry.clip.id)}
                          onCaption={(target) => void captionClip(target.source)}
                          onFixAudio={setFixingTarget}
                          onToggleMute={() =>
                            setClipAudio(entry.clip.id, { muted: !entry.clip.muted })
                          }
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

              {/* The seams, over everything on this row. In their own layer
                  rather than inside the cards because a card hides what
                  overflows it, and half a button in the corner of a clip is not
                  a button. Nothing here takes a pointer except the marks
                  themselves, so dragging a clip still starts on the clip. */}
              <div className="pointer-events-none absolute inset-0">
                {cards.map(({ entry, left, pull, room }) =>
                  entry.index === 0 ? null : (
                    <div
                      key={entry.clip.id}
                      className="pointer-events-auto absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: left + pull / 2 }}
                    >
                      <TransitionMarker
                        transition={entry.transition}
                        room={room}
                        outgoing={assetById.get(positioned[entry.index - 1]?.clip.assetId ?? '')}
                        incoming={assetById.get(entry.clip.assetId)}
                        // The frames that actually meet at this boundary, so the
                        // picker previews this cut rather than a generic one.
                        outgoingAt={Math.max(0, positioned[entry.index - 1]?.clip.outPoint ?? 0)}
                        incomingAt={entry.clip.inPoint}
                        onChange={(next) => setTransition(entry.clip.id, next)}
                        onApplyToAll={setAllTransitions}
                      />
                    </div>
                  ),
                )}
              </div>
            </div>

            <ClipWaveformLane entries={soundEntries} zoom={zoom} />

            {/* And this one "+ Audio track". */}
            <AddTrackSpacer />

            <AudioTrackLanes zoom={zoom} currentTime={currentTime} targets={targets} />

            {/* Captions last, under the audio they were transcribed from. */}
            <CaptionLanes zoom={zoom} onSeek={onSeek} />

            {/* The marked export range, spanning the ruler down through every
                lane so it reads as one stretch of the whole timeline rather
                than a mark on any single track. The band takes no pointer of
                its own — only its two edges do — so everything under it stays
                exactly as reachable as it was. */}
            {exportRange && rangeStart !== null && rangeEnd !== null ? (
              <>
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 bottom-0 border-x-2 border-accent bg-accent/10"
                  style={{ left: rangeStart * zoom, width: (rangeEnd - rangeStart) * zoom }}
                />
                <ExportRangeHandle
                  seconds={exportRange.start}
                  zoom={zoom}
                  label="Export start"
                  onChange={(seconds) => setExportRange({ start: seconds, end: exportRange.end })}
                />
                <ExportRangeHandle
                  seconds={exportRange.end}
                  zoom={zoom}
                  label="Export end"
                  onChange={(seconds) => setExportRange({ start: exportRange.start, end: seconds })}
                />
              </>
            ) : null}

            {contentWidth > 0 ? (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-red-500"
                style={{ left: playheadX }}
              />
            ) : null}

            {/* The band itself, over everything and taking no pointer of its
                own — it is a picture of the drag, and the drag is already
                captured by the column underneath it. */}
            {band ? (
              <div
                aria-hidden
                className="pointer-events-none absolute z-30 border border-accent bg-accent/15"
                style={{
                  left: band.left,
                  top: band.top,
                  width: band.right - band.left,
                  height: band.bottom - band.top,
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Captioning one clip is started from that clip's own menu, so it reports
          here rather than four panels away in the Captions step.

          The padding is for the report bubble, which is fixed to that corner of
          the window (see FeedbackBubble.tsx) and otherwise lands squarely on this
          banner's Cancel and Dismiss buttons — this is the bottom-right of the
          screen in the normal full-height layout. Nothing else in the editor
          puts a control there. */}
      <div className="flex flex-col gap-2 pr-12">
        <CaptionJobStatus />
        {/* Fixing a clip's audio is started from the same menu and reports the
            same way, for the same reason. */}
        <AudioFixStatus />
      </div>

      <FixAudioDialog target={fixingTarget} onClose={() => setFixingTarget(null)} />

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

      <Button
        variant="danger"
        className="ml-auto"
        onClick={() => removeClip(clip.id)}
        title="Remove clip from the timeline (Delete)"
      >
        Remove clip
      </Button>
    </div>
  )
}
