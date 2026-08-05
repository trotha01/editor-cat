import { describe, expect, it } from 'vitest'
import {
  EXPORT_PRESETS,
  aspectRatioFor,
  dimensionsFor,
  exportPresetsFor,
  imageSizeFor,
  orientationOf,
} from './orientation'

describe('orientationOf', () => {
  it('reads orientation back out of the project dimensions', () => {
    expect(orientationOf(720, 1280)).toBe('vertical')
    expect(orientationOf(1280, 720)).toBe('horizontal')
  })

  it('treats square as horizontal rather than leaving it undefined', () => {
    // It has to be one of the two, and 16:9 is what the app defaulted to before.
    expect(orientationOf(1080, 1080)).toBe('horizontal')
  })
})

describe('aspectRatioFor and imageSizeFor', () => {
  it('maps orientation onto each provider’s own vocabulary', () => {
    expect(aspectRatioFor('vertical')).toBe('9:16')
    expect(aspectRatioFor('horizontal')).toBe('16:9')
    expect(imageSizeFor('vertical')).toBe('portrait_16_9')
    expect(imageSizeFor('horizontal')).toBe('landscape_16_9')
  })
})

describe('dimensionsFor', () => {
  it('re-orients without changing the size tier', () => {
    expect(dimensionsFor('vertical', 1280, 720)).toEqual({ width: 720, height: 1280 })
    expect(dimensionsFor('horizontal', 1080, 1920)).toEqual({ width: 1920, height: 1080 })
  })

  it('is a no-op when the size is already in that orientation', () => {
    // Otherwise the toggle would flip every time the selected option is
    // clicked, instead of staying put.
    expect(dimensionsFor('vertical', 720, 1280)).toEqual({ width: 720, height: 1280 })
    expect(dimensionsFor('horizontal', 1280, 720)).toEqual({ width: 1280, height: 720 })
  })

  it('preserves whichever resolution the user picked for export', () => {
    expect(dimensionsFor('vertical', 1920, 1080)).toEqual({ width: 1080, height: 1920 })
    expect(dimensionsFor('vertical', 854, 480)).toEqual({ width: 480, height: 854 })
  })

  it('handles a square input deterministically', () => {
    expect(dimensionsFor('vertical', 1080, 1080)).toEqual({ width: 1080, height: 1080 })
  })
})

describe('EXPORT_PRESETS', () => {
  it('agrees with orientationOf about which way up each preset is', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(orientationOf(preset.width, preset.height)).toBe(preset.orientation)
    }
  })

  it('only offers even dimensions, which H.264 requires', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(preset.width % 2).toBe(0)
      expect(preset.height % 2).toBe(0)
    }
  })

  it('offers the same three tiers in both orientations', () => {
    expect(exportPresetsFor('vertical').map((p) => p.label)).toEqual(['480p', '720p', '1080p'])
    expect(exportPresetsFor('horizontal').map((p) => p.label)).toEqual(['480p', '720p', '1080p'])
  })
})
