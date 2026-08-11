import { describe, expect, it } from 'vitest'
import { exportPlan } from './timelineRender'
import type { Asset, AudioClip, AudioTrack, CaptionTrack, Clip, Project } from '../types'

/**
 * What an export will be, worked out before it is run.
 *
 * This is the description the dialog shows before anyone commits a minute of
 * CPU, *and* the set of decisions the encoder is then handed — deliberately the
 * same derivation, because a summary computed separately from the render is a
 * summary free to be wrong about it. So what is checked here is mostly
 * subtraction: the audio that will not be encoded, the captions that will not
 * be burnt in, and the frame a feed will show, which must not be one of the
 * black ones a lead-in puts at the front.
 */

const clip = (id: string, inPoint: number, outPoint: number, assetId = 'a-vid'): Clip => ({
  id,
  assetId,
  inPoint,
  outPoint,
})

const asset = (id: string, kind: Asset['kind']): Asset => ({
  id,
  kind,
  blobKey: `blob-${id}`,
  mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  name: id,
  createdAt: 0,
})

const track = (id: string, extra: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  kind: 'voice',
  name: id,
  muted: false,
  volume: 1,
  ...extra,
})

const audio = (id: string, trackId: string, startTime: number, duration: number): AudioClip => ({
  id,
  trackId,
  assetId: 'a-snd',
  useConverted: false,
  startTime,
  inPoint: 0,
  duration,
})

const captionTrack = (id: string, hidden: boolean): CaptionTrack => ({
  id,
  name: id,
  hidden,
  style: {
    fontScale: 0.08,
    bold: true,
    uppercase: false,
    color: '#ffffff',
    highlightColor: '#ffee00',
    outlineColor: '#000000',
    outlineScale: 0.1,
    position: 0.8,
  },
})

const base: Project = {
  id: 'p',
  name: 'p',
  clips: [clip('1', 0, 4)],
  audioTracks: [],
  audioClips: [],
  width: 1080,
  height: 1920,
  fps: 30,
}

const assets = [asset('a-vid', 'video'), asset('a-img', 'image'), asset('a-snd', 'audio')]

describe('exportPlan', () => {
  it('runs as long as the picture when nothing outlasts it', () => {
    expect(exportPlan(base, assets).outputDuration).toBe(4)
  })

  it('runs to the end of audio that carries on past the last clip', () => {
    const project: Project = {
      ...base,
      audioTracks: [track('t')],
      audioClips: [audio('v', 't', 3, 5)],
    }
    expect(exportPlan(project, assets).outputDuration).toBe(8)
  })

  it('counts a lead-in as part of the file, since it is encoded', () => {
    expect(exportPlan({ ...base, leadIn: 2 }, assets).outputDuration).toBe(6)
  })

  describe('the thumbnail frame', () => {
    it('is taken from the picture, never from the black in front of it', () => {
      const plan = exportPlan({ ...base, leadIn: 2 }, assets)
      expect(plan.posterTime).toBeGreaterThan(2)
    })

    it('is a second in, which is past most fades', () => {
      expect(exportPlan(base, assets).posterTime).toBe(1)
    })

    it('is halfway through a picture shorter than that', () => {
      expect(exportPlan({ ...base, clips: [clip('1', 0, 0.5)] }, assets).posterTime).toBe(0.25)
    })

    it('stays at the very start of a project with nothing in it', () => {
      expect(exportPlan({ ...base, clips: [] }, assets).posterTime).toBe(0)
    })
  })

  describe('sound', () => {
    it('leaves out clips on a muted track, which would encode as silence', () => {
      const project: Project = {
        ...base,
        audioTracks: [track('loud'), track('quiet', { muted: true })],
        audioClips: [audio('a', 'loud', 0, 2), audio('b', 'quiet', 0, 2)],
      }
      const plan = exportPlan(project, assets)

      expect(plan.audibleClips.map((entry) => entry.id)).toEqual(['a'])
      expect(plan.mutedCount).toBe(1)
    })

    it('treats a track turned all the way down as muted', () => {
      const project: Project = {
        ...base,
        audioTracks: [track('t', { volume: 0 })],
        audioClips: [audio('a', 't', 0, 2)],
      }
      expect(exportPlan(project, assets).audibleClips).toHaveLength(0)
    })

    it('counts only the clips that have sound of their own to keep', () => {
      const project: Project = {
        ...base,
        clips: [clip('1', 0, 2), clip('2', 0, 2, 'a-img'), clip('3', 0, 2)],
      }
      const plan = exportPlan(project, assets)

      // The still is not silenced — it never had any.
      expect(plan.videoClips.map((entry) => entry.id)).toEqual(['1', '3'])
      expect(plan.silencedClips).toBe(0)
    })

    it('counts a video clip the user silenced', () => {
      const project: Project = {
        ...base,
        clips: [clip('1', 0, 2), { ...clip('2', 0, 2), muted: true }],
      }
      expect(exportPlan(project, assets).silencedClips).toBe(1)
    })
  })

  describe('captions', () => {
    const cues = [
      { id: 'c1', trackId: 'shown', start: 0, end: 1, words: [] },
      { id: 'c2', trackId: 'hidden', start: 1, end: 2, words: [] },
    ]

    it('burns in only what the preview is showing', () => {
      const project: Project = {
        ...base,
        captionTracks: [captionTrack('shown', false), captionTrack('hidden', true)],
        captionCues: cues,
      }
      const plan = exportPlan(project, assets)

      expect(plan.burntInCues.map((cue) => cue.id)).toEqual(['c1'])
      expect(plan.captionTracks.map((entry) => entry.id)).toEqual(['shown'])
    })

    it('has nothing to burn in for a project with no captions', () => {
      expect(exportPlan(base, assets).burntInCues).toEqual([])
    })
  })

  it('counts the transitions that shorten the export', () => {
    const project: Project = {
      ...base,
      clips: [
        clip('1', 0, 4),
        { ...clip('2', 0, 4), transition: { kind: 'dissolve', duration: 1 } },
      ],
    }
    const plan = exportPlan(project, assets)

    expect(plan.transitions).toBe(1)
    // 4 + 4, less the second the two of them overlap for.
    expect(plan.outputDuration).toBe(7)
  })
})
