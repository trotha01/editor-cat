import { describe, expect, it } from 'vitest'
import {
  PEAKS_PER_SECOND,
  computePeaks,
  displayHeight,
  resampleBars,
  sliceForClip,
} from './waveform'

/** A signal that is loud for `loudSeconds`, then silent, at 1000 samples/sec. */
function burst(loudSeconds: number, totalSeconds: number, level = 1): Float32Array {
  const rate = 1000
  const samples = new Float32Array(Math.round(totalSeconds * rate))
  for (let index = 0; index < Math.round(loudSeconds * rate); index += 1) {
    // Alternating sign, so anything that sums instead of taking magnitude
    // cancels out to nothing and the test notices.
    samples[index] = index % 2 === 0 ? level : -level
  }
  return samples
}

describe('computePeaks', () => {
  it('reports where the sound is and where it is not', () => {
    const peaks = computePeaks([burst(0.5, 2)], 1000)

    expect(peaks.values.length).toBe(200)
    expect(peaks.values[0]).toBe(1)
    expect(peaks.values[49]).toBe(1)
    expect(peaks.values[50]).toBe(0)
    expect(peaks.values[199]).toBe(0)
  })

  it('measures magnitude, so a waveform is not cancelled out by its own troughs', () => {
    // Close rather than exact: 0.8 is not representable in 32-bit float.
    expect(computePeaks([Float32Array.from([-0.8, 0.2])], 1000).values[0]).toBeCloseTo(0.8, 6)
  })

  it('takes the louder channel rather than averaging them', () => {
    // Hard-panned sound is still sound; averaging would draw it at half level,
    // and a stereo file with one dead channel at half of everything.
    const left = Float32Array.from([1, 1, 1, 1])
    const right = new Float32Array(4)
    expect(computePeaks([left, right], 4, 1).values[0]).toBe(1)
  })

  it('reports the rate it really used, not the one it was asked for', () => {
    // 44100 does not divide into 100 buckets evenly; slicing by time has to
    // use what the bucketing actually came out as or it drifts along the clip.
    const peaks = computePeaks([new Float32Array(44100)], 44100)
    expect(peaks.perSecond).toBe(44100 / Math.round(44100 / PEAKS_PER_SECOND))
    expect(peaks.perSecond).toBeCloseTo(PEAKS_PER_SECOND, 0)
  })

  it('is empty for silence of no length and for a nonsense rate', () => {
    expect(computePeaks([], 44100).values).toHaveLength(0)
    expect(computePeaks([new Float32Array(0)], 44100).values).toHaveLength(0)
    expect(computePeaks([new Float32Array(10)], 0).values).toHaveLength(0)
  })

  it('keeps the tail rather than dropping a partial bucket', () => {
    // 1.005s of audio: the last half-bucket is still audible and must be drawn.
    const peaks = computePeaks([burst(1.005, 1.005)], 1000, 100)
    expect(peaks.values.length).toBe(101)
    expect(peaks.values.at(-1)).toBe(1)
  })
})

describe('sliceForClip', () => {
  const peaks = computePeaks([burst(1, 3)], 1000, 100)

  it('takes the stretch of the file the clip is showing', () => {
    // The first second is loud, so a clip starting at 1s should be silent.
    expect(Math.max(...sliceForClip(peaks, 0, 1))).toBe(1)
    expect(Math.max(...sliceForClip(peaks, 1.1, 1))).toBe(0)
  })

  it('is as long as the clip, in buckets', () => {
    expect(sliceForClip(peaks, 1, 1).length).toBeCloseTo(peaks.perSecond, 0)
  })

  it('stops at the end of the file when the clip runs past it', () => {
    expect(sliceForClip(peaks, 2.5, 10).length).toBeLessThanOrEqual(peaks.values.length)
  })

  it('is empty for a clip with no length, and for peaks with nothing in them', () => {
    expect(sliceForClip(peaks, 0, 0)).toHaveLength(0)
    expect(sliceForClip({ values: new Float32Array(0), perSecond: 100 }, 0, 5)).toHaveLength(0)
  })
})

describe('resampleBars', () => {
  it('gives back exactly the number of bars asked for', () => {
    expect(resampleBars(Float32Array.from([1, 2, 3, 4, 5]), 3)).toHaveLength(3)
    expect(resampleBars(Float32Array.from([1, 2]), 8)).toHaveLength(8)
  })

  it('keeps a transient that averaging would erase', () => {
    // One loud bucket in a hundred is a consonant, or a clap to sync to. It has
    // to survive being squeezed into a handful of pixels.
    const values = new Float32Array(100)
    values[42] = 1
    expect(Math.max(...resampleBars(values, 5))).toBe(1)
  })

  it('stretches without leaving gaps when zoomed in past its resolution', () => {
    const bars = resampleBars(Float32Array.from([0.5, 0.5]), 10)
    expect([...bars].every((value) => value === 0.5)).toBe(true)
  })

  it('copes with nothing to draw', () => {
    expect(resampleBars(new Float32Array(0), 10).every((value) => value === 0)).toBe(true)
    expect(resampleBars(Float32Array.from([1]), 0)).toHaveLength(0)
  })
})

describe('displayHeight', () => {
  it('lifts quiet material clear of the centre line', () => {
    // A tenth of full scale is a normal speech level and would be a single
    // pixel drawn straight, which is indistinguishable from silence.
    expect(displayHeight(0.1)).toBeGreaterThan(0.3)
  })

  it('keeps louder taller than quieter', () => {
    expect(displayHeight(0.5)).toBeGreaterThan(displayHeight(0.2))
    expect(displayHeight(1)).toBe(1)
  })

  it('draws nothing for silence and never overflows the lane', () => {
    expect(displayHeight(0)).toBe(0)
    expect(displayHeight(-1)).toBe(0)
    expect(displayHeight(Number.NaN)).toBe(0)
    expect(displayHeight(4)).toBe(1)
  })
})
