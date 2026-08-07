/**
 * Turning decoded audio into something drawable.
 *
 * Peaks are computed once per asset at a fixed resolution — a magnitude for
 * each hundredth of a second — and everything after that is a slice or a
 * resample of that one array. That is what makes trimming, cutting and zooming
 * free: a clip showing 4s–7s of a file draws the buckets for 4s–7s, and a cut
 * costs nothing because both halves already have their peaks.
 *
 * Magnitude only, no separate minimum: a waveform drawn symmetrically about the
 * centre is what everyone reads as one, and keeping half the data halves the
 * work and the memory for a picture nobody could tell apart.
 *
 * All pure, so the bucketing can be asserted against a signal whose shape is
 * known rather than by looking at a canvas.
 */

/** Buckets per second. 10ms is finer than a single pixel at any usable zoom. */
export const PEAKS_PER_SECOND = 100

export interface Peaks {
  /** Peak magnitude, 0–1, for each bucket of the source in order. */
  values: Float32Array
  /**
   * Buckets per second of source audio. Carried alongside the values because
   * it is the *actual* rate after rounding to whole samples, and slicing by
   * time is only accurate if it uses that rather than what was asked for.
   */
  perSecond: number
}

export const EMPTY_PEAKS: Peaks = { values: new Float32Array(0), perSecond: PEAKS_PER_SECOND }

/**
 * The loudest sample in each bucket, across every channel.
 *
 * Channels are combined by taking whichever is louder rather than by averaging:
 * something hard-panned to one side is still sound, and averaging would draw it
 * at half its real level or, on a stereo file with one silent channel, halve
 * everything.
 */
export function computePeaks(
  channels: readonly Float32Array[],
  sampleRate: number,
  perSecond: number = PEAKS_PER_SECOND,
): Peaks {
  const wanted = perSecond > 0 ? perSecond : PEAKS_PER_SECOND
  const frames = channels[0]?.length ?? 0
  if (frames === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return EMPTY_PEAKS

  const perBucket = Math.max(1, Math.round(sampleRate / wanted))
  const values = new Float32Array(Math.ceil(frames / perBucket))

  for (let bucket = 0; bucket < values.length; bucket += 1) {
    const start = bucket * perBucket
    const end = Math.min(frames, start + perBucket)
    let peak = 0
    for (const channel of channels) {
      for (let index = start; index < end; index += 1) {
        const magnitude = Math.abs(channel[index] ?? 0)
        if (magnitude > peak) peak = magnitude
      }
    }
    values[bucket] = peak
  }

  return { values, perSecond: sampleRate / perBucket }
}

/** The stretch of a file a clip actually shows, in buckets. */
export function sliceForClip(peaks: Peaks, inPoint: number, duration: number): Float32Array {
  if (peaks.values.length === 0 || duration <= 0) return new Float32Array(0)

  const from = Math.max(0, inPoint)
  const start = Math.min(peaks.values.length, Math.floor(from * peaks.perSecond))
  const end = Math.min(peaks.values.length, Math.ceil((from + duration) * peaks.perSecond))
  return end > start ? peaks.values.subarray(start, end) : new Float32Array(0)
}

/**
 * Peaks squeezed onto exactly `bars` columns — or stretched across them, when
 * zoomed in past the resolution they were computed at.
 *
 * Each bar takes the loudest bucket it covers rather than their average. A
 * consonant lasting 20ms is the thing you are looking for when lining a clip
 * up, and averaging is precisely what would erase it.
 */
export function resampleBars(values: Float32Array, bars: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(bars)))
  if (out.length === 0 || values.length === 0) return out

  for (let bar = 0; bar < out.length; bar += 1) {
    const start = Math.floor((bar * values.length) / out.length)
    const end = Math.min(
      values.length,
      Math.max(start + 1, Math.ceil(((bar + 1) * values.length) / out.length)),
    )
    let peak = 0
    for (let index = start; index < end; index += 1) {
      const value = values[index] ?? 0
      if (value > peak) peak = value
    }
    out[bar] = peak
  }

  return out
}

/**
 * How tall to draw a peak, as a fraction of the half-height.
 *
 * Square root rather than straight amplitude. Speech recorded at a sensible
 * level peaks around a tenth of full scale, which in a lane this size is a
 * single pixel and reads as silence — so a linear waveform would be blank
 * exactly where the useful detail is. The curve lifts quiet material into view
 * while keeping louder always taller than quieter, which normalising each clip
 * to its own peak would not: two clips side by side would look equally loud
 * however far apart their levels really were.
 */
export function displayHeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.sqrt(Math.min(1, value))
}
