/**
 * Horizontal or vertical, for the whole pipeline.
 *
 * Video here is made by animating a still, and the export letterboxes every
 * clip into the project's frame (see lib/export/buildGraph.ts). So a shape
 * choice that only reached the video request would produce a 9:16 clip
 * pillarboxed inside a 16:9 file — technically what was asked for, and useless.
 * One value therefore drives three things: the image shape, the video model's
 * `aspect_ratio`, and the export canvas.
 *
 * That value is not stored separately. `Project.width`/`height` already say
 * which way up a project is, already persist to IndexedDB and Supabase, and
 * already drive both the preview and the export filtergraph — so orientation is
 * read back out of them rather than kept alongside and risked drifting.
 */

export type Orientation = 'vertical' | 'horizontal'

/** Square counts as horizontal: it has to be one of the two, and 16:9 is the older default. */
export function orientationOf(width: number, height: number): Orientation {
  return height > width ? 'vertical' : 'horizontal'
}

export function aspectRatioFor(orientation: Orientation): '9:16' | '16:9' {
  return orientation === 'vertical' ? '9:16' : '16:9'
}

/** fal's `image_size` enum, so a generated first frame already has the right shape. */
export function imageSizeFor(orientation: Orientation): 'portrait_16_9' | 'landscape_16_9' {
  return orientation === 'vertical' ? 'portrait_16_9' : 'landscape_16_9'
}

/**
 * Re-orients a frame size without changing how big it is: 1280×720 → 720×1280.
 *
 * Deliberately not a swap. Asking for the orientation something already has
 * must leave it alone, or the control flips every time it is re-applied — and
 * whichever tier the user chose in the export dialog survives the change.
 */
export function dimensionsFor(
  orientation: Orientation,
  width: number,
  height: number,
): { width: number; height: number } {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  return orientation === 'vertical'
    ? { width: short, height: long }
    : { width: long, height: short }
}

export interface ExportPreset {
  label: string
  orientation: Orientation
  width: number
  height: number
}

/**
 * The frame a new project starts on.
 *
 * The smallest tier, and deliberately: the render runs in this tab on the
 * user's own CPU with ffmpeg compiled to WebAssembly, so frame size is mostly
 * minutes spent waiting on an export. A first cut that comes back quickly is
 * worth more than a sharp one that does not, and the two larger tiers are one
 * Select away in the export dialog — where whichever was chosen then survives
 * an orientation flip, since `dimensionsFor` re-orients rather than resizes.
 *
 * Kept in `EXPORT_PRESETS` below rather than written out twice: the dialog
 * matches the project's size against the presets, and a default that drifted
 * out of that list would show up as an extra "Current" option.
 */
export const DEFAULT_PRESET: ExportPreset = {
  label: '480p',
  orientation: 'vertical',
  width: 480,
  height: 854,
}

/** H.264 needs even dimensions in both axes, which every pair here satisfies. */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  DEFAULT_PRESET,
  { label: '720p', orientation: 'vertical', width: 720, height: 1280 },
  { label: '1080p', orientation: 'vertical', width: 1080, height: 1920 },
  { label: '480p', orientation: 'horizontal', width: 854, height: 480 },
  { label: '720p', orientation: 'horizontal', width: 1280, height: 720 },
  { label: '1080p', orientation: 'horizontal', width: 1920, height: 1080 },
]

export function exportPresetsFor(orientation: Orientation): ExportPreset[] {
  return EXPORT_PRESETS.filter((preset) => preset.orientation === orientation)
}

export const ORIENTATION_LABELS: Readonly<Record<Orientation, string>> = {
  vertical: 'Vertical 9:16',
  horizontal: 'Horizontal 16:9',
}
