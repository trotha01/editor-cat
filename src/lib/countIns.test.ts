import { describe, expect, it } from 'vitest'
import { planCountIns } from './countIns'
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

    // Not a mark at the head of clip-2: nothing has been transcribed there, so
    // a count-in on its first frame would be running into silence.
    expect(plan.beeps.map((beep) => beep.clipId)).toEqual(['clip-1', 'clip-3'])
  })

  it('ignores captions that name something other than a picture clip', () => {
    const plan = planCountIns(
      project({
        clips: [clip('clip-1', 5)],
        captionCues: [
          // A voiceover is transcribed too, and its cues are credited to the
          // audio clip. It was placed by hand at the moment it belongs at, so
          // there is nothing about it for a count-in to lead into.
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
    // clip-1 has no mark of its own, so nothing asks the lead-in to grow.
    expect(plan.leadIn).toBe(4)
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

  describe('the lead-in in front of the first clip', () => {
    it('grows just enough to fit the first clip’s own count-in when there is not room', () => {
      const plan = planCountIns(
        project({ clips: THREE_SHOTS, captionCues: [cue('a', 0.2, 'clip-1')] }),
      )

      // The three beeps need a full count-in's length; 0.2s of it was already
      // there, so the rest — 2.8s — is what the lead-in grows by.
      expect(plan.leadIn).toBeCloseTo(countdownSeconds() - 0.2)
    })

    it('leaves the lead-in alone once the first clip already gives it enough room', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          captionCues: [cue('a', countdownSeconds() + 0.1, 'clip-1')],
        }),
      )

      expect(plan.leadIn).toBe(0)
    })

    it('leaves a longer lead-in alone rather than pulling it in to fit', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          // Ten seconds of black somebody asked for. Pulling it in to fit the
          // count-in exactly would be undoing their work rather than adding to
          // it — the beeps can run into the word just as well from inside it.
          leadIn: 10,
          captionCues: [cue('a', 10.1, 'clip-1')],
        }),
      )

      expect(plan.leadIn).toBe(10)
    })

    it('does not grow the lead-in for a first clip that says nothing', () => {
      const plan = planCountIns(
        project({
          clips: THREE_SHOTS,
          // The second shot starts talking on its own first frame, which is no
          // reason to push the picture back — clip-2 has clip-1's picture
          // already playing in front of it for the beeps to run over.
          captionCues: [cue('b', 5.1, 'clip-2')],
        }),
      )

      expect(plan.leadIn).toBe(0)
      expect(plan.beeps.map((beep) => beep.clipId)).toEqual(['clip-2'])
      expect(plan.beeps[0]?.offset).toBeCloseTo(0.1)
    })
  })

  it('has nothing to do with no captions at all', () => {
    const plan = planCountIns(project({ clips: THREE_SHOTS }))
    expect(plan).toEqual({ leadIn: 0, beeps: [] })
  })
})
