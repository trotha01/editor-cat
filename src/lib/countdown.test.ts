import { describe, expect, it } from 'vitest'
import {
  COUNTDOWN_SPEC,
  WAV_MIME,
  countdownSamples,
  countdownSeconds,
  countdownWav,
  encodeWav,
} from './countdown'

const RATE = COUNTDOWN_SPEC.sampleRate

/** Loudest sample in a stretch of the signal, given in seconds. */
function peakBetween(samples: Float32Array, from: number, to: number): number {
  let peak = 0
  const end = Math.min(samples.length, Math.round(to * RATE))
  for (let index = Math.max(0, Math.round(from * RATE)); index < end; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0))
  }
  return peak
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1)
    text += String.fromCharCode(view.getUint8(offset + index))
  return text
}

describe('countdownSeconds', () => {
  it('runs a full interval past the last beep', () => {
    // The point of the clip is that its right-hand edge is the moment to come
    // in on. Ending it on the last beep instead would put the mark a second
    // early, and every count-in dragged into place would be a second out.
    expect(countdownSeconds()).toBe(3)
  })

  it('follows the spec it is given', () => {
    expect(countdownSeconds({ ...COUNTDOWN_SPEC, beeps: 4, interval: 0.5 })).toBe(2)
  })
})

describe('countdownSamples', () => {
  const samples = countdownSamples()

  it('is exactly as long as the count-in', () => {
    expect(samples.length).toBe(3 * RATE)
  })

  it('sounds a beep on each whole second', () => {
    for (const second of [0, 1, 2]) {
      expect(peakBetween(samples, second, second + COUNTDOWN_SPEC.beepSeconds)).toBeGreaterThan(0.4)
    }
  })

  it('is silent between the beeps', () => {
    for (const second of [0, 1, 2]) {
      expect(peakBetween(samples, second + 0.2, second + 0.9)).toBe(0)
    }
  })

  it('is silent after the last beep, right up to the mark', () => {
    // This tail is what you line up with the take: a beep bleeding into it
    // would land on top of the first word.
    expect(peakBetween(samples, 2.2, 3)).toBe(0)
  })

  it('leaves headroom rather than running at full scale', () => {
    // The exporter sums tracks without normalising, so a cue at unity would
    // clip whatever it is counting into.
    expect(peakBetween(samples, 0, 3)).toBeLessThanOrEqual(COUNTDOWN_SPEC.amplitude)
    expect(COUNTDOWN_SPEC.amplitude).toBeLessThan(1)
  })

  it('starts and ends each beep at zero, so it clicks at neither end', () => {
    const beepEnd = Math.round(COUNTDOWN_SPEC.beepSeconds * RATE) - 1
    for (const second of [0, 1, 2]) {
      const offset = second * RATE
      // Math.abs, because the fade multiplies a negative sine down to -0.
      expect(Math.abs(samples[offset] ?? NaN)).toBe(0)
      expect(Math.abs(samples[offset + beepEnd] ?? NaN)).toBe(0)
    }
  })

  it('keeps a beep longer than the gap inside the buffer', () => {
    // Degenerate, but it must not write past the end of the array or throw.
    const odd = countdownSamples({ ...COUNTDOWN_SPEC, beeps: 2, interval: 0.1, beepSeconds: 5 })
    expect(odd.length).toBe(Math.round(0.2 * RATE))
    expect(peakBetween(odd, 0, 0.2)).toBeGreaterThan(0)
  })
})

describe('encodeWav', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const view = new DataView(encodeWav(samples, 8000))

  it('writes a RIFF/WAVE header ffmpeg and the browser both accept', () => {
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(ascii(view, 36, 4)).toBe('data')
  })

  it('declares mono 16-bit PCM at the rate it was given', () => {
    expect(view.getUint16(20, true)).toBe(1) // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint32(28, true)).toBe(16000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16)
  })

  it('states the sizes the data really is', () => {
    // A wrong size here is the classic way to produce a file that plays for a
    // moment and then stops, or one ffmpeg refuses outright.
    expect(view.byteLength).toBe(44 + samples.length * 2)
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('round-trips the samples within 16-bit precision', () => {
    samples.forEach((sample, index) => {
      const stored = view.getInt16(44 + index * 2, true) / 0x7fff
      expect(stored).toBeCloseTo(sample, 3)
    })
  })

  it('does not overflow at full scale in either direction', () => {
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767)
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768)
  })
})

describe('countdownWav', () => {
  it('is a WAV blob of the expected size', () => {
    const blob = countdownWav()
    expect(blob.type).toBe(WAV_MIME)
    expect(blob.size).toBe(44 + 3 * RATE * 2)
  })
})
