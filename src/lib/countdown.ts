/**
 * The count-in: three beeps, synthesised rather than shipped.
 *
 * A count-in is a tiny, fixed signal — three sine bursts a second apart — so
 * generating it costs a millisecond of arithmetic and saves shipping an audio
 * file, fetching it, and finding out at export time that it never made it into
 * the build. It also makes the timing exact: each beep starts on a whole
 * second and the last one is followed by silence, so the *end* of the clip is
 * the mark to come in on. Line that edge up with where the take should start
 * and the beeps lead into it.
 *
 * The output is a 16-bit PCM WAV. Both the browser's `<audio>` and ffmpeg.wasm
 * decode that without a codec, which matters because preview and export have to
 * agree; three seconds is a couple of hundred kilobytes, which is nothing next
 * to the video it sits under.
 *
 * Everything here is pure and returns plain buffers, so the beeps can be
 * asserted on sample by sample in a test instead of listened to.
 */

export interface CountdownSpec {
  /** How many beeps sound before the mark. */
  beeps: number
  /** Seconds from the start of one beep to the start of the next. */
  interval: number
  /** How long each beep sounds for. */
  beepSeconds: number
  /** Pitch of each beep, in Hz. 1kHz is the broadcast tone and cuts through. */
  frequency: number
  /**
   * Peak level, 0–1. Deliberately short of full scale: the mixer sums tracks
   * without normalising, so a cue at unity would clip whatever it plays over.
   */
  amplitude: number
  /** Matches the export's mixing rate, so nothing has to be resampled. */
  sampleRate: number
}

export const COUNTDOWN_SPEC: CountdownSpec = {
  beeps: 3,
  interval: 1,
  beepSeconds: 0.15,
  frequency: 1000,
  amplitude: 0.5,
  sampleRate: 48000,
}

/**
 * One beep, and no silence after it.
 *
 * A different job from the count-in above, which is why it is a different
 * length rather than the same clip with two beeps taken out. A count-in is
 * played *into* — its tail is the mark — whereas this marks a moment that has
 * already been chosen for it, so what it sounds against is its left edge and a
 * tail would only be room for it to collide with the next one.
 *
 * `interval` carries the whole length when there is a single beep, so setting
 * it to the beep's own length is what makes the clip stop where the sound does.
 */
export const BEEP_SPEC: CountdownSpec = {
  ...COUNTDOWN_SPEC,
  beeps: 1,
  interval: COUNTDOWN_SPEC.beepSeconds,
}

/** What the generated asset is called in the library. */
export const COUNTDOWN_ASSET_NAME = '3-beep countdown'

/** And the single beep, kept apart so the two are never mistaken for each other. */
export const BEEP_ASSET_NAME = '1-beep mark'

/** What the clip is called on the timeline. */
export const COUNTDOWN_LABEL = 'Countdown'

/**
 * What an auto-placed beep is called on the timeline.
 *
 * Load-bearing, not decoration: it is how a second run finds the beeps the last
 * one laid, so the marks can be redone after a recaption instead of doubling
 * up. See `addCountInBeeps`.
 */
export const BEEP_LABEL = 'Beep'

export const WAV_MIME = 'audio/wav'

/**
 * Fade applied to each end of a beep, in seconds.
 *
 * A sine cut off mid-cycle is a step change, and a step change is a click. Eight
 * milliseconds is long enough to remove it and far too short to soften the
 * attack, which a cue needs to stay sharp enough to play to.
 */
const RAMP_SECONDS = 0.008

/**
 * How long the whole count-in lasts.
 *
 * The last beep is followed by the rest of its interval, so the clip ends on the
 * beat after the final beep — the moment to start on.
 */
export function countdownSeconds(spec: CountdownSpec = COUNTDOWN_SPEC): number {
  return Math.max(0, spec.beeps) * Math.max(0, spec.interval)
}

/** Linear fade in and out, flat in between. 1 where the beep is at full level. */
function envelope(index: number, length: number, ramp: number): number {
  if (ramp <= 0) return 1
  const fromEnd = length - 1 - index
  return Math.max(0, Math.min(1, index / ramp, fromEnd / ramp))
}

/** The count-in as mono float samples in [-amplitude, amplitude]. */
export function countdownSamples(spec: CountdownSpec = COUNTDOWN_SPEC): Float32Array {
  const { sampleRate } = spec
  const samples = new Float32Array(Math.round(countdownSeconds(spec) * sampleRate))
  // A beep longer than the gap between beeps would run into the next one, and
  // the last would run off the end of the buffer.
  const beepLength = Math.min(Math.round(spec.beepSeconds * sampleRate), samples.length)
  const ramp = Math.min(Math.round(RAMP_SECONDS * sampleRate), Math.floor(beepLength / 2))

  for (let beep = 0; beep < spec.beeps; beep += 1) {
    const offset = Math.round(beep * spec.interval * sampleRate)
    for (let index = 0; index < beepLength && offset + index < samples.length; index += 1) {
      const angle = (2 * Math.PI * spec.frequency * index) / sampleRate
      samples[offset + index] = spec.amplitude * envelope(index, beepLength, ramp) * Math.sin(angle)
    }
  }

  return samples
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/** Float samples to a mono 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2
  const dataBytes = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // length of this chunk
  view.setUint16(20, 1, true) // 1 = uncompressed PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 8 * bytesPerSample, true) // bits per sample

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    // Negative and positive halves have different room in two's complement, so
    // scaling by the wrong one of these is what turns a clean sine into buzz.
    view.setInt16(
      44 + index * bytesPerSample,
      Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)),
      true,
    )
  }

  return buffer
}

/** The count-in as a WAV file, ready to be ingested like any other audio. */
export function countdownWav(spec: CountdownSpec = COUNTDOWN_SPEC): Blob {
  return new Blob([encodeWav(countdownSamples(spec), spec.sampleRate)], { type: WAV_MIME })
}
