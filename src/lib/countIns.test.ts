import { describe, expect, it } from 'vitest'
import { OPENING_SILENCE, planCountIns } from './countIns'
import { countdownSeconds } from './countdown'
import type { CaptionCue, Clip, Project } from './types'

const clip = (id: string, seconds: number): Clip => ({
  id,
  assetId: `asset-${id}`,
  inPoint: 0,
  outPoint: seconds,
})

/** A caption at `start`, credited to the clip it was heard in. */
const cue = (id: string, start: number, sourceId?: string): CaptionCue => ({
  id,
  trackId: 'ctrack',
  start,
  end: start + 1,
  words: [{ id: `w-${id}`, text: 'hello', start, end: start + 0.4 }],
  ...(sourceId ? { source: { id: sourceId, label: sourceId } } : {}),
})

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
  ...overrides,
})

/** Three shots, five seconds each, running 0–5, 5–10 and 10–15. */
const THREE_SHOTS = [clip('clip-1', 5), clip('clip-2', 5), clip('clip-3', 5)]

describe('planCountIns', () => {
  it('marks each clip at the offset its first word sits at', () => {
    const plan = planCountIns(
      project({
        clips: THREE_SHOTS,
        // 2s into the first shot, 1.5s into the second, 0.5s into the third.
        captionCues: [cue('a', 2, 'clip-1'), cue('b', 6.5, 'clip-2'), cue('c', 10.5, 'clip-3')],
      }),
    )

    expect(plan.beeps).toEqual([
      { clipId: 'clip-1', offset: 2 },
      { clipId: 'clip-2', offset: 1.5 },
      { clipId: 'clip-3', offset: 0.5 },
    ])
  })

  it('takes the earliest caption in a clip, however the cues are ordered', () => {
    const plan = planCountIns(
      project({
        clips: [clip('clip-1', 5)],
        // Cues are not stored in time order — the transcript is edited, split
        // and merged in place — so the first in the array need not be the first
        // to be spoken.
        captionCues: [cue('b', 3, 'clip-1'), cue('a', 1, 'clip-1'), cue('c', 4, 'clip-1')],
      }),
    )

    expect(plan.beeps).toEqual([{ clipId: 'clip-1', offset: 1 }])
  })

  it('leaves a clip with no captions unmarked', () => {
    const plan = planCountIns(
      project({
        clips: THREE_SHOTS,
        captionCues: [cue('a', 1, 'clip-1'), cue('c', 11, 'clip-3')],
      }),
    )

    // Not a beep at the head of clip-2: nothing has been transcribed there, so
    // a mark on its first frame would be announcing silence.
    expect(plan.beeps.map((beep) => beep.clipId)).toEqual(['clip-1', 'clip-3'])
  })

  it('ignores captions that name something other than a picture clip', () => {
    const plan = planCountIns(
      project({
        clips: [clip('clip-1', 5)],
        captionCues: [
          // A voiceover is transcribed too, and its cues are credited to the
          // audio clip. It was placed by hand at the moment it belongs at,
          // so there is nothing about it for a beep to announce.
          cue('vo', 1, 'aclip-1'),
          // And a caption typed by hand belongs to nobody.
          cue('typed', 2),
          cue('a', 3, 'clip-1'),
        ],
      }),
    )

    expect(plan.beeps).toEqual([{ clipId: 'clip-1', offset: 3 }])
  })

  it('measures the offset into the clip, not along the timeline', () => {
    const plan = planCountIns(
      project({
        clips: THREE_SHOTS,
        // The picture already starts four seconds in, so clip-2 runs 9–14.
        leadIn: 4,
        captionCues: [cue('b', 10.5, 'clip-2')],
      }),
    )

    // 1.5s into its own shot, which is what survives the picture moving.
    expect(plan.beeps).toEqual([{ clipId: 'clip-2', offset: 1.5 }])
  })

  it('clamps a caption dragged in front of its own clip to the clip’s head', () => {
    const plan = planCountIns(
      project({
        clips: THREE_SHOTS,
        // Dragged back into the shot before it. A negative offset would put the
        // mark on clip-1, which is not the clip it belongs to.
        captionCues: [cue('b', 4.5, 'clip-2')],
      }),
    )

    expect(plan.beeps).toEqual([{ clipId: 'clip-2', offset: 0 }])
  })

  describe('the count-in in front of the picture', () => {
    it('asks for one when the first clip talks from the off', () => {
      const plan = planCountIns(
        project({ clips: THREE_SHOTS, captionCues: [cue('a', 0.2, 'clip-1')] }),
      )

      expect(plan.leadIn).toBe(countdownSeconds())
      // At zero, with its tail meeting the first frame.
      expect(plan.opening).toBe(0)
    })

    it('does not when the first clip gives the viewer a beat first', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          captionCues: [cue('a', OPENING_SILENCE + 0.1, 'clip-1')],
        }),
      )

      expect(plan.opening).toBeNull()
      expect(plan.leadIn).toBe(0)
    })

    it('leaves a longer lead-in alone and still runs into the first frame', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          // Ten seconds of black somebody asked for. Pulling it in to three to
          // fit the beeps would be undoing their work rather than adding to it.
          leadIn: 10,
          captionCues: [cue('a', 10.1, 'clip-1')],
        }),
      )

      expect(plan.leadIn).toBe(10)
      expect(plan.opening).toBe(10 - countdownSeconds())
    })

    it('does not count into a first clip that says nothing', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          // The second shot starts talking on its own first frame, which is no
          // reason to count into a first shot that is silent.
          captionCues: [cue('b', 5.1, 'clip-2')],
        }),
      )

      expect(plan.opening).toBeNull()
      expect(plan.beeps.map((beep) => beep.clipId)).toEqual(['clip-2'])
      expect(plan.beeps[0]?.offset).toBeCloseTo(0.1)
    })
  })

  it('has nothing to do with no captions at all', () => {
    const plan = planCountIns(project({ clips: THREE_SHOTS }))
    expect(plan).toEqual({ opening: null, leadIn: 0, beeps: [] })
  })
})
