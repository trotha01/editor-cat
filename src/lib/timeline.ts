/**
 * Pure timeline arithmetic. No React, no IO — this is the layer where the
 * "did the trim land in the right place" bugs would otherwise live, so it is
 * kept side-effect free and unit tested directly.
 */
import { audioEnd } from './audioTracks'
import { fitTransitions } from './transitions'
import { videoLayersEnd } from './videoTracks'
import type { Asset, Clip, PositionedClip, Project } from './types'

/** Shortest clip we allow. Below this, trimming produces unplayable slivers. */
export const MIN_CLIP_DURATION = 0.2

/** Duration a still image gets when first added to the timeline. */
export const DEFAULT_IMAGE_DURATION = 4

/** Longest a single still image may be held on screen. */
export const MAX_IMAGE_DURATION = 60

/**
 * Longest lead-in we allow. Past this it stops being a count-in and becomes a
 * minute of black someone has to sit through, probably by accident.
 */
export const MAX_LEAD_IN = 60

export function clampLeadIn(seconds: number): number {
  return clamp(Number.isFinite(seconds) ? seconds : 0, 0, MAX_LEAD_IN)
}

/**
 * A project's lead-in, guarded.
 *
 * Absent — which is every project saved before it existed — is none, so the
 * picture starts where it always did.
 */
export function leadInOf(project: { leadIn?: number }): number {
  return clampLeadIn(project.leadIn ?? 0)
}

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.outPoint - clip.inPoint)
}

/**
 * Resolves every clip to an absolute start/end on the timeline.
 *
 * The lead-in is applied here rather than at each call site, so everything
 * built on these positions — what is on screen, where a cut lands, how long the
 * export runs — moves with the picture instead of some of it being left behind.
 *
 * Transitions are applied here for the same reason, and they are the one thing
 * that makes these intervals overlap: a clip with a transition starts early by
 * exactly the length of it, so for that stretch both clips are on screen. The
 * overlap always ends precisely where the earlier clip does, which is what lets
 * the export hand the same two numbers straight to `xfade`.
 */
export function layoutClips(clips: readonly Clip[], leadIn = 0): PositionedClip[] {
  const transitions = fitTransitions(clips)
  let cursor = clampLeadIn(leadIn)
  return clips.map((clip, index) => {
    const duration = clipDuration(clip)
    const transition = transitions[index] ?? null
    if (transition) cursor = Math.max(0, cursor - transition.duration)
    const positioned: PositionedClip = {
      clip,
      index,
      start: cursor,
      end: cursor + duration,
      duration,
      transition,
    }
    cursor = positioned.end
    return positioned
  })
}

/**
 * How long the picture itself runs, ignoring where it starts.
 *
 * Read off the layout rather than summed, because a transition overlaps two
 * clips and the picture is shorter than they add up to by exactly that much.
 */
export function totalDuration(clips: readonly Clip[]): number {
  const laid = layoutClips(clips)
  return laid[laid.length - 1]?.end ?? 0
}

/** When the picture finishes: its length plus whatever precedes it. */
export function pictureEnd(project: Pick<Project, 'clips' | 'leadIn'>): number {
  return leadInOf(project) + totalDuration(project.clips)
}

/**
 * Total length of the project, which is the longer of the visual track and the
 * audio tracks — a count-in, a voiceover or a music bed may run before the
 * first clip or past the last one.
 */
export function projectDuration(project: Project): number {
  return Math.max(
    pictureEnd(project),
    audioEnd(project.audioClips ?? []),
    videoLayersEnd(project.videoClips ?? []),
  )
}

/**
 * The clip playing at time `t`, or null if `t` is past the end — or before the
 * picture starts, which is what makes a lead-in read as black rather than as a
 * frozen first frame.
 *
 * Inside a transition two clips are on screen and the earlier one wins here,
 * because it is the one still playing: the incoming clip is arriving *over* it,
 * and that half of the picture is `transitionAt`'s to describe.
 */
export function clipAtTime(clips: readonly Clip[], t: number, leadIn = 0): PositionedClip | null {
  if (t < 0) return null
  const laid = layoutClips(clips, leadIn)
  for (const positioned of laid) {
    // Half-open interval so a boundary time belongs to exactly one clip.
    if (t >= positioned.start && t < positioned.end) return positioned
  }
  // Exactly at the end of the last clip, hold on that clip's final frame.
  const last = laid[laid.length - 1]
  if (last && t === last.end && last.duration > 0) return last
  return null
}

/** Converts a timeline time to a seek position within the clip's source asset. */
export function sourceTimeFor(positioned: PositionedClip, timelineTime: number): number {
  const offset = clamp(timelineTime - positioned.start, 0, positioned.duration)
  return positioned.clip.inPoint + offset
}

/**
 * Applies a trim, clamping to both the minimum clip length and the bounds of
 * the underlying asset. Returns a new clip; never mutates.
 *
 * For images there is no source material to run out of, so the outPoint is
 * clamped to MAX_IMAGE_DURATION rather than the asset duration.
 */
export function trimClip(
  clip: Clip,
  asset: Asset | undefined,
  edge: 'start' | 'end',
  nextValue: number,
): Clip {
  const isImage = asset?.kind === 'image'
  const sourceLimit = isImage
    ? MAX_IMAGE_DURATION
    : (asset?.duration ?? Math.max(clip.outPoint, MIN_CLIP_DURATION))

  if (edge === 'start') {
    // Images have no in-point to move: dragging the left edge would only
    // shorten them, which the right edge already does.
    if (isImage) return clip
    const maxIn = clip.outPoint - MIN_CLIP_DURATION
    return { ...clip, inPoint: clamp(nextValue, 0, Math.max(0, maxIn)) }
  }

  const minOut = clip.inPoint + MIN_CLIP_DURATION
  return { ...clip, outPoint: clamp(nextValue, minOut, Math.max(minOut, sourceLimit)) }
}

/** Frames per second to fall back on when a stored project names none. */
const DEFAULT_FPS = 30

/** Slack for comparing times. Far below one frame at any usable rate. */
const TIME_EPSILON = 1e-6

/** The project's frame rate, guarded — everything below divides by it. */
function frameRate(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS
}

/** How long one frame lasts, in seconds. */
export function frameDuration(fps: number): number {
  return 1 / frameRate(fps)
}

/**
 * The frame boundary nearest `seconds`.
 *
 * Cuts go through this so they land on the lines the timeline draws. A cut
 * halfway into a frame would be rounded by the exporter anyway, and then the
 * two halves no longer add up to the lengths you were shown.
 *
 * Counted in whole frames rather than by multiplying a frame's length, which
 * accumulates enough float error to miss the boundary it is aiming at.
 */
export function snapToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  const rate = frameRate(fps)
  return Math.round(seconds * rate) / rate
}

/**
 * The clip a cut at `time` would fall in, or null when nothing can be cut
 * there.
 *
 * Both halves have to clear MIN_CLIP_DURATION, the same floor trimming works
 * to — a cut is only another way of setting an edge, and a two-frame sliver
 * left behind by a mis-aimed cut is not something anyone wanted.
 *
 * A cut inside a transition is refused too. The frames under a transition are
 * being blended with a neighbour's, so cutting there would ask for a boundary
 * in the middle of one — leaving two clips that have to overlap something that
 * is no longer there, and a picture that changes as a result of a cut, which is
 * the one thing a cut must never do.
 */
export function cutTargetAt(
  clips: readonly Clip[],
  time: number,
  fps: number,
  leadIn = 0,
): PositionedClip | null {
  const at = snapToFrame(time, fps)
  const laid = layoutClips(clips, leadIn)
  // Strictly inside: a cut exactly on a clip boundary is one that already
  // exists, and would otherwise produce an empty clip.
  const target = laid.find((entry) => at > entry.start && at < entry.end)
  if (!target) return null

  const offset = at - target.start
  const floor = MIN_CLIP_DURATION - TIME_EPSILON
  if (offset < floor || target.duration - offset < floor) return null

  // Its own transition eats the head of it; the next clip's eats the tail.
  const intoThis = target.transition?.duration ?? 0
  const intoNext = laid[target.index + 1]?.transition?.duration ?? 0
  if (offset < intoThis + TIME_EPSILON) return null
  if (target.duration - offset < intoNext + TIME_EPSILON) return null
  return target
}

export interface CutResult {
  clips: Clip[]
  /**
   * The clip starting at the cut, or the survivor of a join. Selected
   * afterwards, so the next edit lands on what the playhead is sitting over.
   */
  clipId: string
  /**
   * The clip that was cut in two, which keeps its id as the half in front.
   * Anything credited to that id and sitting past the cut — captions — belongs
   * to `clipId` now, and only the caller can move it across.
   */
  cutClipId: string
}

/**
 * Cuts the clip under `time` in two at the nearest frame.
 *
 * Both halves keep pointing at the same source, and together they cover exactly
 * what the one clip covered — so a cut changes nothing about what plays until
 * you move, trim or delete one of the halves. Returns null when there is
 * nothing cuttable there, leaving the caller's clips alone.
 *
 * `makeId` is injected so this stays pure and testable.
 */
export function splitClipAt(
  clips: readonly Clip[],
  time: number,
  fps: number,
  makeId: () => string,
  leadIn = 0,
): CutResult | null {
  const target = cutTargetAt(clips, time, fps, leadIn)
  if (!target) return null

  const { clip } = target
  const boundary = clip.inPoint + (snapToFrame(time, fps) - target.start)

  const left: Clip = { ...clip, outPoint: boundary }
  // The half in front keeps the transition, because it keeps the boundary the
  // transition is about. The new half begins at a cut, which is what a cut is.
  const { transition: _uncarried, ...carried } = clip
  const right: Clip = { ...carried, id: makeId(), inPoint: boundary }

  const next = [...clips]
  next.splice(target.index, 1, left, right)
  return { clips: next, clipId: right.id, cutClipId: clip.id }
}

/**
 * Whether two neighbours are the two halves of one cut: the same source,
 * carrying on across the boundary. This is what makes a cut visible when a
 * project is opened again — nothing extra is stored, because two clips meeting
 * mid-source is exactly what a cut *is*.
 */
export function isThroughCut(left: Clip, right: Clip): boolean {
  return left.assetId === right.assetId && Math.abs(right.inPoint - left.outPoint) <= TIME_EPSILON
}

/**
 * Puts back the cut in front of `clipId`, merging the two halves into one.
 *
 * Refused unless the neighbours really are the halves of a cut, because merging
 * two unrelated clips would silently throw one of them away. Returns null when
 * refused, so a click on nothing is a no-op rather than an edit.
 */
export function joinCutAt(clips: readonly Clip[], clipId: string): CutResult | null {
  const index = clips.findIndex((clip) => clip.id === clipId)
  if (index <= 0) return null // unknown clip, or the first one, which has no cut in front of it

  const left = clips[index - 1]
  const right = clips[index]
  if (!left || !right || !isThroughCut(left, right)) return null

  // The survivor keeps the transition in front of it and loses the one at the
  // cut, along with the cut: there is no boundary left there to have one.
  const merged: Clip = { ...left, outPoint: right.outPoint }
  const next = [...clips]
  next.splice(index - 1, 2, merged)
  return { clips: next, clipId: merged.id, cutClipId: right.id }
}

/**
 * Effective gain for a clip's own sound.
 *
 * Both fields are optional, and absent has to mean "as recorded" rather than
 * silent — otherwise every clip added before clips had sound would export mute.
 * Images have no sound to gain, but the arithmetic is harmless.
 */
export function clipGain(clip: Clip): number {
  if (clip.muted) return 0
  return Math.max(0, clip.volume ?? 1)
}

/** Builds the clip for a newly added asset, with sensible default bounds. */
export function clipForAsset(asset: Asset, id: string): Clip {
  if (asset.kind === 'image') {
    return { id, assetId: asset.id, inPoint: 0, outPoint: DEFAULT_IMAGE_DURATION }
  }
  const duration = asset.duration && asset.duration > 0 ? asset.duration : DEFAULT_IMAGE_DURATION
  return { id, assetId: asset.id, inPoint: 0, outPoint: duration }
}

/**
 * How far each clip's start moved between two arrangements, keyed by clip id.
 *
 * Rearranging the picture leaves every clip pointing at the same source for the
 * same length, and only somewhere else on the timeline. Anything anchored to
 * where a clip sits rather than to the clip itself — captions, which are timed
 * in absolute seconds — has to be carried by the same distance, and this is the
 * only place that can say what that distance was, because it is the difference
 * between two layouts and neither one alone holds it.
 *
 * Clips that did not move are left out, as are ones missing from either side:
 * a clip that was just added has no previous position to have moved from, and
 * one that was removed has no new position to move to.
 */
export function clipStartDeltas(
  before: readonly Clip[],
  after: readonly Clip[],
  leadIn = 0,
): Map<string, number> {
  const was = new Map(layoutClips(before, leadIn).map((entry) => [entry.clip.id, entry.start]))
  const deltas = new Map<string, number>()
  for (const entry of layoutClips(after, leadIn)) {
    const previous = was.get(entry.clip.id)
    if (previous === undefined) continue
    const delta = entry.start - previous
    if (Math.abs(delta) > TIME_EPSILON) deltas.set(entry.clip.id, delta)
  }
  return deltas
}

/** Moves a clip from one index to another, returning a new array. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Next zoom for one wheel tick of a trackpad pinch — or an actual Ctrl+wheel,
 * which the browser reports the same way and this treats the same. Scales the
 * current zoom rather than adding to it, so a pinch feels the same size at any
 * zoom level instead of crawling near `min` and leaping near `max`.
 */
export function zoomFromPinch(zoom: number, deltaY: number, min: number, max: number): number {
  // A real mouse wheel under Ctrl sends a much bigger deltaY per notch than a
  // trackpad ever does; clamped first so one click can't jump the whole range.
  const delta = clamp(deltaY, -50, 50)
  return clamp(zoom * Math.exp(-delta * 0.01), min, max)
}

/** Formats a length of time as m:ss.d, for clip labels and durations. */
export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const mins = Math.floor(safe / 60)
  const secs = safe - mins * 60
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`
}

/**
 * A *position* on the timeline, as m:ss:ff — minutes, seconds, and the frame
 * within that second.
 *
 * Where a clip's length reads fine in tenths, a playhead does not: a tenth of a
 * second is three frames at 30fps, so it names a moment nothing can actually be
 * cut on. The frame is the unit everything else here works in — it is what the
 * arrow keys step by, what a cut snaps to, and what the grid draws — so it is
 * what the readout should count in.
 *
 * A colon before the frames rather than a point, because they are a count and
 * not a fraction: `0:01:24` is the twenty-fifth frame of that second, and
 * writing it `0:01.24` invites reading it as a quarter of one.
 */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = frameRate(fps)
  // Whole frames per second, for the part that is displayed. A rate like 29.97
  // still counts 0–29 within a second; only how long each lasts differs.
  const perSecond = Math.max(1, Math.round(rate))
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  // Rounded once, to frames, and the seconds derived from that — rounding the
  // two separately is how a readout ends up claiming a thirtieth frame.
  const total = Math.round(safe * rate)
  const whole = Math.floor(total / perSecond)
  const frame = total - whole * perSecond
  const mins = Math.floor(whole / 60)
  return `${mins}:${String(whole % 60).padStart(2, '0')}:${String(frame).padStart(2, '0')}`
}

/**
 * Moves a time by whole frames.
 *
 * Counted in frames rather than by adding a frame's length, for the reason
 * `snapToFrame` is counted that way too: repeatedly adding 1/30 drifts far
 * enough to skip a frame, and a step that sometimes moves two is worse than no
 * step at all. Lands on a frame boundary whatever it was given.
 */
export function stepFrames(seconds: number, frames: number, fps: number): number {
  const rate = frameRate(fps)
  const from = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  return Math.max(0, Math.round(from * rate) + Math.round(frames)) / rate
}
