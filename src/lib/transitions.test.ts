import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITIONS,
  canTransitionAt,
  clampTransitionDuration,
  fitTransitions,
  formatTransitionDuration,
  transitionAt,
  transitionOf,
  transitionRoomAt,
  transitionStyles,
  withTransition,
  xfadeNameOf,
} from './transitions'
import { layoutClips } from './timeline'
import type { Clip, Transition, TransitionKind } from './types'

const clip = (id: string, seconds: number, transition?: Transition): Clip => ({
  id,
  assetId: 'a-vid',
  inPoint: 0,
  outPoint: seconds,
  ...(transition ? { transition } : {}),
})

const dissolve = (duration = DEFAULT_TRANSITION_DURATION): Transition => ({
  kind: 'dissolve',
  duration,
})

describe('transitionOf', () => {
  it('reads none off a clip saved before transitions existed', () => {
    expect(transitionOf(clip('1', 3))).toBeNull()
  })

  it('reads one that is there', () => {
    expect(transitionOf(clip('1', 3, dissolve(0.5)))).toEqual({ kind: 'dissolve', duration: 0.5 })
  })

  it('refuses a kind neither renderer knows how to draw', () => {
    // A project written by a later version of the app, opened by this one.
    const stored = { ...clip('1', 3), transition: { kind: 'kaleidoscope', duration: 0.4 } }
    expect(transitionOf(stored as unknown as Clip)).toBeNull()
  })

  it('refuses a length that is nonsense', () => {
    expect(transitionOf(clip('1', 3, { kind: 'dissolve', duration: 0 }))).toBeNull()
    expect(transitionOf(clip('1', 3, { kind: 'dissolve', duration: Number.NaN }))).toBeNull()
  })
})

describe('fitTransitions', () => {
  it('leaves a timeline of straight cuts alone', () => {
    expect(fitTransitions([clip('1', 3), clip('2', 2)])).toEqual([null, null])
  })

  it('drops one stored on the first clip, which has no boundary in front of it', () => {
    expect(fitTransitions([clip('1', 3, dissolve()), clip('2', 2)])[0]).toBeNull()
  })

  it('keeps one both clips can afford', () => {
    const fitted = fitTransitions([clip('1', 3), clip('2', 2, dissolve(0.5))])
    expect(fitted[1]).toEqual({ kind: 'dissolve', duration: 0.5 })
  })

  it('cuts one down to the shorter of the two clips it joins', () => {
    const fitted = fitTransitions([clip('1', 3), clip('2', 0.6, dissolve(1.5))])
    expect(fitted[1]?.duration).toBe(0.6)
  })

  it('drops one the clips are too short to show at all', () => {
    expect(fitTransitions([clip('1', 3), clip('2', 0.05, dissolve())])[1]).toBeNull()
  })

  it('caps the longest transition on offer', () => {
    const fitted = fitTransitions([clip('1', 30), clip('2', 30, dissolve(10))])
    expect(fitted[1]?.duration).toBe(MAX_TRANSITION_DURATION)
  })

  it('will not let two transitions share the same frames', () => {
    // The middle clip is one second long and owes 0.8s to the boundary in front
    // of it, so the boundary behind it gets only the 0.2s that are left. The
    // earlier one keeps its length: splitting the difference would move a
    // boundary the user never touched.
    const fitted = fitTransitions([
      clip('1', 5),
      clip('2', 1, dissolve(0.8)),
      clip('3', 5, dissolve(0.8)),
    ])
    expect(fitted[1]?.duration).toBe(0.8)
    expect(fitted[2]?.duration).toBeCloseTo(0.2)
  })

  it('drops the second of two transitions when there is nothing left over', () => {
    const fitted = fitTransitions([
      clip('1', 5),
      clip('2', 1, dissolve(0.95)),
      clip('3', 5, dissolve(0.8)),
    ])
    expect(fitted[2]).toBeNull()
  })

  it('changes nothing about what the clips store', () => {
    // Trimming a clip short must not destroy the transition on it: pull it long
    // again and the transition it was given should still be there.
    const short = [clip('1', 5), clip('2', 0.2, dissolve(0.6))]
    expect(fitTransitions(short)[1]?.duration).toBe(0.2)
    const long = [short[0] as Clip, { ...(short[1] as Clip), outPoint: 4 }]
    expect(fitTransitions(long)[1]?.duration).toBe(0.6)
  })
})

describe('transitionRoomAt', () => {
  it('is nothing at all in front of the first clip', () => {
    expect(transitionRoomAt([clip('1', 3), clip('2', 3)], 0)).toBe(0)
  })

  it('is the shorter of the two clips', () => {
    expect(transitionRoomAt([clip('1', 3), clip('2', 0.75)], 1)).toBe(0.75)
  })

  it('leaves room for the transition on the far side of the incoming clip', () => {
    // Growing this one must never silently shorten its neighbour.
    const clips = [clip('1', 5), clip('2', 1), clip('3', 5, dissolve(0.4))]
    expect(transitionRoomAt(clips, 1)).toBeCloseTo(0.6)
  })

  it('reports nothing where the clips are too short to spare any', () => {
    expect(canTransitionAt([clip('1', 3), clip('2', 0.05)], 1)).toBe(false)
    expect(canTransitionAt([clip('1', 3), clip('2', 3)], 1)).toBe(true)
  })
})

describe('clampTransitionDuration', () => {
  it('holds a length inside what the boundary can hold', () => {
    expect(clampTransitionDuration(5, 0.8)).toBe(0.8)
    expect(clampTransitionDuration(-1, 0.8)).toBe(0)
    expect(clampTransitionDuration(0.4, 0.8)).toBe(0.4)
  })

  it('never exceeds the cap, whatever room it is offered', () => {
    expect(clampTransitionDuration(60, 60)).toBe(MAX_TRANSITION_DURATION)
  })
})

describe('withTransition', () => {
  it('takes the key off entirely when there is none, rather than storing undefined', () => {
    const cleared = withTransition(clip('1', 3, dissolve()), null)
    expect('transition' in cleared).toBe(false)
  })

  it('sets one without touching anything else', () => {
    const set = withTransition(clip('1', 3), dissolve(0.5))
    expect(set).toEqual({ ...clip('1', 3), transition: { kind: 'dissolve', duration: 0.5 } })
  })
})

describe('transitionAt', () => {
  const laid = layoutClips([clip('1', 4), clip('2', 4, dissolve(1))])

  it('finds nothing where the clips only meet', () => {
    expect(transitionAt(layoutClips([clip('1', 4), clip('2', 4)]), 4)).toBeNull()
  })

  it('runs from where the incoming clip starts to where the outgoing one ends', () => {
    expect(transitionAt(laid, 2.99)).toBeNull()
    expect(transitionAt(laid, 3)?.progress).toBe(0)
    expect(transitionAt(laid, 3.5)?.progress).toBeCloseTo(0.5)
    // The frame the outgoing clip ends on is the first frame that is only the
    // incoming one, so it is past the transition rather than the end of it.
    expect(transitionAt(laid, 4)).toBeNull()
  })

  it('names both clips, going out and coming in', () => {
    const active = transitionAt(laid, 3.5)
    expect(active?.from.clip.id).toBe('1')
    expect(active?.to.clip.id).toBe('2')
    expect(active?.kind).toBe('dissolve')
  })
})

describe('transitionStyles', () => {
  it('crosses a dissolve over, so the two opacities always add up to one', () => {
    for (const p of [0, 0.25, 0.5, 1]) {
      const { from, to } = transitionStyles('dissolve', p)
      expect((from.opacity ?? 1) + (to.opacity ?? 0)).toBeCloseTo(1)
    }
  })

  it('really dips: a dip is fully on its colour halfway through', () => {
    const half = transitionStyles('dipToBlack', 0.5)
    expect(half.from.opacity).toBe(0)
    expect(half.to.opacity).toBe(0)
    expect(half.backdrop).toBe('#000000')
    expect(transitionStyles('dipToWhite', 0.5).backdrop).toBe('#ffffff')
  })

  it('shows only the outgoing clip at the start and only the incoming one at the end', () => {
    for (const { kind } of TRANSITIONS) {
      const start = transitionStyles(kind, 0)
      const end = transitionStyles(kind, 1)
      // Whatever the shape, nothing of the incoming clip is on screen before it
      // begins, and all of it is by the time it is over.
      expect(hidden(start.to)).toBe(true)
      expect(hidden(end.to)).toBe(false)
    }
  })

  it('clamps a progress from outside the transition', () => {
    expect(transitionStyles('dissolve', -1).to.opacity).toBe(0)
    expect(transitionStyles('dissolve', 5).to.opacity).toBe(1)
  })

  it('falls back to a blend for a kind it does not know', () => {
    const unknown = transitionStyles('kaleidoscope' as TransitionKind, 0.5)
    expect(unknown.to.opacity).toBe(0.5)
  })
})

/** Whether a layer is drawing nothing at all: invisible, clipped away, or off-frame. */
function hidden(style: { opacity?: number; clipPath?: string; transform?: string }): boolean {
  if (style.opacity === 0) return true
  // Clipped away entirely: an inset that takes the whole frame, or a circle of
  // no radius at all.
  if (style.clipPath?.includes('100.00%') || style.clipPath?.includes('circle(0.00%')) return true
  if (style.transform?.includes('(100.00%)') || style.transform?.includes('(-100.00%)')) return true
  return false
}

describe('the catalogue', () => {
  it('names an xfade transition for every kind on offer', () => {
    for (const entry of TRANSITIONS) {
      expect(xfadeNameOf(entry.kind)).toBe(entry.xfade)
      expect(entry.xfade).toMatch(/^[a-z]+$/)
    }
  })

  it('offers a cross dissolve, which is the one anybody comes here for', () => {
    const found = TRANSITIONS.find((entry) => entry.kind === 'dissolve')
    // ffmpeg's own `dissolve` is a random-pixel effect; a cross dissolve is `fade`.
    expect(found?.xfade).toBe('fade')
  })

  it('falls back to a blend rather than to an invalid filter argument', () => {
    expect(xfadeNameOf('kaleidoscope' as TransitionKind)).toBe('fade')
  })

  it('defaults to something between the shortest and the longest allowed', () => {
    expect(DEFAULT_TRANSITION_DURATION).toBeGreaterThanOrEqual(MIN_TRANSITION_DURATION)
    expect(DEFAULT_TRANSITION_DURATION).toBeLessThanOrEqual(MAX_TRANSITION_DURATION)
  })
})

describe('formatTransitionDuration', () => {
  it('counts in milliseconds, which is the only unit this short reads in', () => {
    expect(formatTransitionDuration(0.4)).toBe('400ms')
    expect(formatTransitionDuration(1)).toBe('1000ms')
    expect(formatTransitionDuration(-1)).toBe('0ms')
  })
})
