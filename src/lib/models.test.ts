import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIDEO_MODEL,
  SPEECH_COST_PER_MINUTE,
  VIDEO_MODELS,
  costPerSecondFor,
  defaultResolutionFor,
  encodeDuration,
  findVideoModel,
  formatCost,
  speechCost,
  type VideoModel,
} from './models'

const seedance = findVideoModel(DEFAULT_VIDEO_MODEL)!
const wan = findVideoModel('fal-ai/wan-i2v')!

describe('the video default', () => {
  it('is Seedance 2.0, generating 480p', () => {
    expect(DEFAULT_VIDEO_MODEL).toBe('bytedance/seedance-2.0/fast/image-to-video')
    expect(defaultResolutionFor(seedance)).toBe('480p')
  })
})

describe('defaultResolutionFor', () => {
  it('prefers the declared default over the highest option', () => {
    expect(defaultResolutionFor(seedance)).toBe('480p')
  })

  it('still falls back to the highest where no default is declared', () => {
    // Wan 2.1 behaved this way before per-model defaults existed, and should
    // keep behaving that way.
    expect(defaultResolutionFor(wan)).toBe('720p')
  })

  it('ignores a default that is not actually on offer', () => {
    // Sending it would be an invalid enum, which fal rejects outright.
    const bogus = { ...wan, defaultResolution: '4k' } as VideoModel
    expect(defaultResolutionFor(bogus)).toBe('720p')
  })

  it('returns an empty string for a model that takes no resolution', () => {
    expect(defaultResolutionFor(findVideoModel('fal-ai/veo3/image-to-video')!)).toBe('')
  })
})

describe('costPerSecondFor', () => {
  it('uses the per-resolution figure where the spread is too wide for one number', () => {
    expect(costPerSecondFor(seedance, '480p')).toBeLessThan(costPerSecondFor(seedance, '720p'))
  })

  it('falls back to the flat estimate for models without a breakdown', () => {
    expect(costPerSecondFor(wan, '480p')).toBe(wan.approxCostPerSecond)
    expect(costPerSecondFor(seedance, 'something-else')).toBe(seedance.approxCostPerSecond)
  })
})

describe('encodeDuration', () => {
  it('matches what Seedance asks for: a numeric string', () => {
    expect(encodeDuration(5, seedance.durationFormat)).toBe('5')
  })
})

describe('registry integrity', () => {
  // This file is the one place the README promises can be edited without any
  // code change, so typos here need catching cheaply.
  it('offers at least one duration per model, cheapest first', () => {
    for (const model of VIDEO_MODELS) {
      expect(model.durations.length).toBeGreaterThan(0)
      expect([...model.durations]).toEqual([...model.durations].sort((a, b) => a - b))
    }
  })

  it('only names resolutions the model actually offers', () => {
    for (const model of VIDEO_MODELS) {
      const options = model.resolutions ?? []
      if (model.defaultResolution) expect(options).toContain(model.defaultResolution)
      for (const key of Object.keys(model.costPerSecondByResolution ?? {})) {
        expect(options).toContain(key)
      }
    }
  })
})

describe('speechCost', () => {
  it('charges a minute of audio at the published minute rate', () => {
    expect(speechCost(60)).toBeCloseTo(SPEECH_COST_PER_MINUTE, 10)
  })

  it('is pro-rata, which is what a price "per minute of input audio" says', () => {
    // A bill that rounded each request up to a whole minute would come out
    // higher on a project made of several short takes. Estimating the published
    // price is the honest thing to do; guessing at the rounding is not.
    expect(speechCost(30)).toBeCloseTo(SPEECH_COST_PER_MINUTE / 2, 10)
    expect(speechCost(150)).toBeCloseTo(SPEECH_COST_PER_MINUTE * 2.5, 10)
  })

  it('costs nothing when there is nothing to transcribe', () => {
    expect(speechCost(0)).toBe(0)
    expect(speechCost(-5)).toBe(0)
    expect(speechCost(Number.NaN)).toBe(0)
  })

  it('reads as "less than a cent" rather than as free for a short take', () => {
    // Everything up to about a minute lands under $0.01, and "$0.00" next to a
    // button would read as "this one is free".
    expect(formatCost(speechCost(20))).toBe('<$0.01')
    expect(formatCost(speechCost(0))).toBe('—')
  })

  it('is worth showing at the length a real project reaches', () => {
    // Ten minutes of talking is an ordinary amount for a set of takes, and it
    // is where the estimate stops being a rounding error.
    expect(formatCost(speechCost(600))).toBe('~$0.08')
  })
})
