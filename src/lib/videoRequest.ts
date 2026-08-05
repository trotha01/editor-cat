/**
 * Builds the request body for a video generation.
 *
 * A pure function over plain data, for the same reason `lib/export/buildGraph`
 * is one: the interesting bugs here are "we sent a field this model does not
 * have" and "we sent the duration in the wrong shape", and both are far easier
 * to catch in a unit test asserting on an object than by spending a minute and
 * real money watching a job fail.
 *
 * The governing rule is that every optional field is opt-in. fal answers an
 * unrecognised field with a 422 rather than ignoring it, so a model that has
 * not declared support for something must be sent nothing at all.
 */
import { encodeDuration, type VideoModel } from './models'
import { aspectRatioFor, type Orientation } from './orientation'

export interface VideoRequestOptions {
  /** Undefined for a custom model ID, where nothing about the model is known. */
  model: VideoModel | undefined
  prompt: string
  imageUrl: string
  endImageUrl?: string
  duration: number
  /** Empty when the model takes no resolution. */
  resolution: string
  orientation: Orientation
  /** The advanced "extra JSON" box. Merged last, so it can override anything. */
  extra?: Record<string, unknown>
}

export function buildVideoInput({
  model,
  prompt,
  imageUrl,
  endImageUrl,
  duration,
  resolution,
  orientation,
  extra,
}: VideoRequestOptions): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt,
    image_url: imageUrl,
    duration: encodeDuration(duration, model?.durationFormat ?? 'number'),
  }

  if (resolution) input.resolution = resolution

  // Models without this field take their shape from the first frame instead,
  // which the image step has already generated in the right orientation.
  const wanted = aspectRatioFor(orientation)
  if (model?.aspectRatios?.includes(wanted)) input.aspect_ratio = wanted

  // Seedance generates audio by default, but clip audio is never mixed into the
  // export and the preview mutes it (see lib/export/buildGraph), so it would be
  // paid for and then thrown away.
  if (model?.supportsAudioToggle) input.generate_audio = false

  if (model?.supportsEndFrame && endImageUrl) input.end_image_url = endImageUrl

  if (extra) Object.assign(input, extra)

  return input
}
