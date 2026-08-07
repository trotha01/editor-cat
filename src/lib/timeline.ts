/**
 * Pure timeline arithmetic. No React, no IO — this is the layer where the
 * "did the trim land in the right place" bugs would otherwise live, so it is
 * kept side-effect free and unit tested directly.
 */
import { audioEnd } from './audioTracks'
import type { Asset, Clip, PositionedClip, Project } from './types'

/** Shortest clip we allow. Below this, trimming produces unplayable slivers. */
export const MIN_CLIP_DURATION = 0.2

/** Duration a still image gets when first added to the timeline. */
export const DEFAULT_IMAGE_DURATION = 4

/** Longest a single still image may be held on screen. */
export const MAX_IMAGE_DURATION = 60

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.outPoint - clip.inPoint)
}

/** Resolves every clip to an absolute start/end on the timeline. */
export function layoutClips(clips: readonly Clip[]): PositionedClip[] {
  let cursor = 0
  return clips.map((clip, index) => {
    const duration = clipDuration(clip)
    const positioned: PositionedClip = {
      clip,
      index,
      start: cursor,
      end: cursor + duration,
      duration,
    }
    cursor += duration
    return positioned
  })
}

export function totalDuration(clips: readonly Clip[]): number {
  return clips.reduce((sum, clip) => sum + clipDuration(clip), 0)
}

/**
 * Total length of the project, which is the longer of the visual track and the
 * audio tracks — a voiceover or a music bed may run past the last clip.
 */
export function projectDuration(project: Project): number {
  return Math.max(totalDuration(project.clips), audioEnd(project.audioClips ?? []))
}

/** The clip playing at time `t`, or null if `t` is past the end. */
export function clipAtTime(clips: readonly Clip[], t: number): PositionedClip | null {
  if (t < 0) return null
  const laid = layoutClips(clips)
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

/** Formats seconds as m:ss.d for the ruler and clip labels. */
export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const mins = Math.floor(safe / 60)
  const secs = safe - mins * 60
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`
}
