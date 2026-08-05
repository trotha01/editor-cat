import { describe, expect, it } from 'vitest'
import { buildVideoInput } from './videoRequest'
import { DEFAULT_VIDEO_MODEL, findVideoModel, type VideoModel } from './models'

const seedance = findVideoModel(DEFAULT_VIDEO_MODEL)!
const kling = findVideoModel('fal-ai/kling-video/v2/master/image-to-video')!
const luma = findVideoModel('fal-ai/luma-dream-machine/image-to-video')!

function base(model: VideoModel | undefined, overrides: Record<string, unknown> = {}) {
  return {
    model,
    prompt: 'push in slowly',
    imageUrl: 'https://fal.media/first.jpg',
    duration: 5,
    resolution: '',
    orientation: 'vertical' as const,
    ...overrides,
  }
}

describe('buildVideoInput', () => {
  it('always sends the prompt, the first frame and a duration', () => {
    const input = buildVideoInput(base(kling))
    expect(input.prompt).toBe('push in slowly')
    expect(input.image_url).toBe('https://fal.media/first.jpg')
    expect(input.duration).toBe('5')
  })

  it('encodes the duration the way each model wants it', () => {
    // The one place provider APIs disagree pointlessly.
    expect(buildVideoInput(base(kling)).duration).toBe('5')
    expect(buildVideoInput(base(luma)).duration).toBe('5s')
    expect(buildVideoInput(base(undefined)).duration).toBe(5)
  })

  it('sends aspect_ratio only to a model that declares it', () => {
    // fal answers an unknown field with a 422, so guessing breaks the request
    // rather than being quietly ignored.
    expect(buildVideoInput(base(seedance, { resolution: '480p' })).aspect_ratio).toBe('9:16')
    expect(buildVideoInput(base(kling))).not.toHaveProperty('aspect_ratio')
    expect(buildVideoInput(base(undefined))).not.toHaveProperty('aspect_ratio')
  })

  it('follows the requested orientation', () => {
    const horizontal = buildVideoInput(base(seedance, { orientation: 'horizontal' }))
    expect(horizontal.aspect_ratio).toBe('16:9')
  })

  it('turns off generated audio, which the export would discard anyway', () => {
    expect(buildVideoInput(base(seedance)).generate_audio).toBe(false)
    expect(buildVideoInput(base(kling))).not.toHaveProperty('generate_audio')
  })

  it('omits resolution when the model takes none', () => {
    expect(buildVideoInput(base(seedance, { resolution: '480p' })).resolution).toBe('480p')
    expect(buildVideoInput(base(kling, { resolution: '' }))).not.toHaveProperty('resolution')
  })

  it('sends an end frame only when there is one and the model accepts it', () => {
    const url = 'https://fal.media/last.jpg'
    expect(buildVideoInput(base(seedance, { endImageUrl: url })).end_image_url).toBe(url)
    expect(buildVideoInput(base(kling, { endImageUrl: url }))).not.toHaveProperty('end_image_url')
    expect(buildVideoInput(base(seedance))).not.toHaveProperty('end_image_url')
  })

  it('lets the advanced JSON box override anything we chose', () => {
    // That box exists so a stale registry never makes the app unusable, which
    // only works if it wins.
    const input = buildVideoInput(
      base(seedance, {
        resolution: '480p',
        extra: { seed: 42, aspect_ratio: '1:1', generate_audio: true },
      }),
    )
    expect(input.seed).toBe(42)
    expect(input.aspect_ratio).toBe('1:1')
    expect(input.generate_audio).toBe(true)
  })
})
