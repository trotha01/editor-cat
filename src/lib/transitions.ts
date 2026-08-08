/**
 * Transitions between clips on the picture track.
 *
 * A transition is an *overlap*: for its length the outgoing clip and the
 * incoming one are both on screen, and the timeline gets shorter by exactly
 * that much. Every other way of doing it is a worse effect wearing the same
 * name — hold a frozen frame either side to keep the length and you get two
 * stills fading into each other, which is visibly not what a dissolve is.
 *
 * So the overlap is the whole model, and everything else follows from it:
 * `layoutClips` pulls each clip back by its transition, the preview draws both
 * clips through it, and the export hands the same two numbers to `xfade`. There
 * is one number stored per boundary and no separate list of effects to keep in
 * step with the clips.
 *
 * What a boundary can afford is worked out here rather than enforced at the
 * point of setting it. A stored transition is a *wish*: trim its clips shorter
 * and it has to shrink, trim them longer and it should come back. `fitTransitions`
 * is that reconciliation, applied on read by everything that lays clips out, so
 * no edit anywhere else can leave the timeline describing an overlap that the
 * material cannot cover.
 *
 * Pure, and free of React and ffmpeg alike: what a transition renders as in each
 * is a lookup at the edge, and this is the arithmetic underneath both.
 */
import type { Clip, PositionedClip, Transition, TransitionKind } from './types'

/** What Descript opens with, and a good default: long enough to read as a blend. */
export const DEFAULT_TRANSITION_DURATION = 0.4

/**
 * Shortest transition worth having. Below this it is three frames of blend that
 * reads as a glitch, so a boundary that cannot afford this much gets a straight
 * cut instead.
 */
export const MIN_TRANSITION_DURATION = 0.1

/** Longest we allow. Past a couple of seconds it stops being a cut at all. */
export const MAX_TRANSITION_DURATION = 2

/** One kind of transition, and how each renderer draws it. */
export interface TransitionDef {
  kind: TransitionKind
  label: string
  /** What it looks like, for the picker's tooltip. */
  hint: string
  /**
   * The ffmpeg `xfade` transition that renders it in the export.
   *
   * Note that xfade's own `dissolve` is a random-pixel dissolve, which is not
   * what the word means in an edit suite — a cross dissolve is `fade`.
   */
  xfade: string
}

/**
 * The transitions on offer, in the order the picker lays them out.
 *
 * A short list on purpose. Each one has to be drawable twice — once in CSS for
 * the preview and once by `xfade` for the export — and a transition that only
 * one of the two can draw is a transition that lies about what you are going to
 * get.
 */
export const TRANSITIONS: readonly TransitionDef[] = [
  {
    kind: 'dissolve',
    label: 'Cross dissolve',
    hint: 'One shot blends straight into the next.',
    xfade: 'fade',
  },
  {
    kind: 'dipToBlack',
    label: 'Dip to black',
    hint: 'Out to black and back up again — a beat between scenes.',
    xfade: 'fadeblack',
  },
  {
    kind: 'dipToWhite',
    label: 'Dip to white',
    hint: 'The same, flashed through white.',
    xfade: 'fadewhite',
  },
  {
    kind: 'blur',
    label: 'Blur',
    hint: 'Softens out of one shot and back into focus on the next.',
    xfade: 'hblur',
  },
  {
    kind: 'wipeLeft',
    label: 'Wipe left',
    hint: 'The new shot wipes across from the right.',
    xfade: 'wipeleft',
  },
  {
    kind: 'wipeRight',
    label: 'Wipe right',
    hint: 'The new shot wipes across from the left.',
    xfade: 'wiperight',
  },
  {
    kind: 'slideLeft',
    label: 'Slide left',
    hint: 'The new shot pushes the old one off to the left.',
    xfade: 'slideleft',
  },
  {
    kind: 'slideRight',
    label: 'Slide right',
    hint: 'The new shot pushes the old one off to the right.',
    xfade: 'slideright',
  },
  {
    kind: 'iris',
    label: 'Iris',
    hint: 'The new shot opens out from the middle of the frame.',
    xfade: 'circleopen',
  },
]

const BY_KIND = new Map(TRANSITIONS.map((entry) => [entry.kind, entry]))

/** The definition for a kind, or undefined for one we do not know. */
export function transitionDef(kind: TransitionKind): TransitionDef | undefined {
  return BY_KIND.get(kind)
}

/** What to call a transition on screen. */
export function transitionLabel(kind: TransitionKind): string {
  return BY_KIND.get(kind)?.label ?? 'Transition'
}

/** The `xfade` transition that renders a kind, falling back to a plain blend. */
export function xfadeNameOf(kind: TransitionKind): string {
  return BY_KIND.get(kind)?.xfade ?? 'fade'
}

/**
 * A clip's stored transition, guarded.
 *
 * Stored projects come back from IndexedDB and from Supabase as whatever was
 * written, including by a version of this app that offered a kind this one does
 * not — so an unrecognised kind reads as no transition rather than as something
 * neither renderer can draw.
 */
export function transitionOf(clip: Clip | undefined): Transition | null {
  const transition = clip?.transition
  if (!transition || !BY_KIND.has(transition.kind)) return null
  const duration = Number(transition.duration)
  if (!Number.isFinite(duration) || duration <= 0) return null
  return { kind: transition.kind, duration }
}

export function clampTransitionDuration(seconds: number, room = MAX_TRANSITION_DURATION): number {
  const ceiling = Math.min(MAX_TRANSITION_DURATION, room)
  if (!Number.isFinite(seconds)) return 0
  return Math.max(0, Math.min(seconds, ceiling))
}

/** How long a clip runs, mirroring `clipDuration` so this stays free of the timeline. */
function lengthOf(clip: Clip | undefined): number {
  return clip ? Math.max(0, clip.outPoint - clip.inPoint) : 0
}

/**
 * Every boundary's transition, cut down to what its two clips can actually give
 * up. Index-aligned with `clips`; null at index 0 and at every straight cut.
 *
 * Two rules, and both are the same rule: a clip cannot be in two places at once.
 * A transition may be no longer than either neighbour, and a clip caught between
 * two transitions has to cover both — so its incoming and outgoing overlaps
 * together may not exceed its own length. Resolved in one forward pass, which
 * lets the earlier transition keep its length and the later one give way; the
 * alternative, splitting the difference, moves a boundary the user never touched.
 *
 * Nothing is written back. What is stored stays stored, so pulling a clip short
 * and then long again brings its transition back rather than having silently
 * destroyed it.
 */
export function fitTransitions(clips: readonly Clip[]): (Transition | null)[] {
  const fitted: (Transition | null)[] = []
  for (let index = 0; index < clips.length; index += 1) {
    const wanted = index === 0 ? null : transitionOf(clips[index])
    if (!wanted) {
      fitted.push(null)
      continue
    }
    // What the clip in front still has left, after whatever it already gives to
    // its own incoming transition — and what this clip has, all of it, since
    // anything it owes to the *next* boundary is settled on the next pass.
    const room = Math.min(
      lengthOf(clips[index - 1]) - (fitted[index - 1]?.duration ?? 0),
      lengthOf(clips[index]),
    )
    const duration = clampTransitionDuration(wanted.duration, room)
    fitted.push(duration >= MIN_TRANSITION_DURATION ? { kind: wanted.kind, duration } : null)
  }
  return fitted
}

/**
 * The longest transition the boundary in front of `index` could hold.
 *
 * Unlike the fitting pass this also leaves room for the transition on the far
 * side of the incoming clip, so dragging one longer never silently shortens its
 * neighbour. 0 where no transition is possible at all — the first clip, or a
 * boundary between clips too short to spare anything.
 */
export function transitionRoomAt(clips: readonly Clip[], index: number): number {
  if (index <= 0 || index >= clips.length) return 0
  const fitted = fitTransitions(clips)
  const room = Math.min(
    lengthOf(clips[index - 1]) - (fitted[index - 1]?.duration ?? 0),
    lengthOf(clips[index]) - (fitted[index + 1]?.duration ?? 0),
  )
  return clampTransitionDuration(room)
}

/** Whether a transition of at least the minimum length would fit at a boundary. */
export function canTransitionAt(clips: readonly Clip[], index: number): boolean {
  return transitionRoomAt(clips, index) >= MIN_TRANSITION_DURATION
}

/** A clip with its transition set, or with the key gone when there is none. */
export function withTransition(clip: Clip, transition: Transition | null): Clip {
  if (!transition) {
    const { transition: _cleared, ...rest } = clip
    return rest
  }
  return { ...clip, transition }
}

/** The transition running at time `t`, with how far through it the playhead is. */
export interface ActiveTransition {
  /** The clip going out. */
  from: PositionedClip
  /** The clip coming in, which is the one the transition is stored on. */
  to: PositionedClip
  kind: TransitionKind
  duration: number
  /** 0 where the overlap begins, 1 where it ends. */
  progress: number
}

/**
 * The transition the playhead is inside, or null between them.
 *
 * Read off a laid-out timeline rather than off the clips, because the overlap
 * only exists once the clips have been given positions — and because this has
 * to agree with what `clipAtTime` says is on screen, which is laid out the same
 * way.
 */
export function transitionAt(
  positioned: readonly PositionedClip[],
  t: number,
): ActiveTransition | null {
  for (let index = 1; index < positioned.length; index += 1) {
    const to = positioned[index]
    const from = positioned[index - 1]
    const transition = to?.transition
    if (!to || !from || !transition) continue
    if (t < to.start || t >= from.end) continue
    const progress = Math.max(0, Math.min(1, (t - to.start) / transition.duration))
    return { from, to, kind: transition.kind, duration: transition.duration, progress }
  }
  return null
}

/**
 * The CSS one layer of a transition needs. Plain data, so this stays testable
 * and out of React — it is assignable to a style object as it is.
 */
export interface TransitionLayerStyle {
  opacity?: number
  clipPath?: string
  transform?: string
  filter?: string
}

/** How both layers of a transition draw at one moment. */
export interface TransitionRender {
  /** For the clip going out. */
  from: TransitionLayerStyle
  /** For the clip coming in, which is drawn over the other. */
  to: TransitionLayerStyle
  /**
   * A solid colour to lay behind both, for the transitions that pass through
   * one. Absent when the two clips only ever touch each other.
   */
  backdrop?: string
}

/** How far out of focus a blur transition goes, at its midpoint. */
const BLUR_RADIUS_PX = 28

/**
 * A circle big enough to reach the corners. CSS resolves a percentage radius
 * against the diagonal over root two, which puts a corner at just under 71%.
 */
const IRIS_FULL_RADIUS = 72

/**
 * What the two clips look like `progress` of the way through a transition.
 *
 * This is the preview's half of the promise the export keeps with `xfade`: the
 * same names, the same directions, the same midpoint. Where the two can only be
 * close — a browser's blur is not ffmpeg's — the shape of the thing is the same,
 * which is what the picker is really showing.
 */
export function transitionStyles(kind: TransitionKind, progress: number): TransitionRender {
  const p = Math.max(0, Math.min(1, progress))

  switch (kind) {
    case 'dipToBlack':
    case 'dipToWhite': {
      // Two halves, not one blend: out to the colour by the midpoint, and only
      // then back up. Overlapping the fades would leave the picture visible
      // right through and never dip at all.
      return {
        from: { opacity: Math.max(0, 1 - p * 2) },
        to: { opacity: Math.max(0, p * 2 - 1) },
        backdrop: kind === 'dipToBlack' ? '#000000' : '#ffffff',
      }
    }
    case 'blur':
      return {
        from: { opacity: 1 - p, filter: `blur(${(p * BLUR_RADIUS_PX).toFixed(1)}px)` },
        to: { opacity: p, filter: `blur(${((1 - p) * BLUR_RADIUS_PX).toFixed(1)}px)` },
      }
    case 'wipeLeft':
      // The edge travels leftwards, so the new picture is uncovered from the
      // right. The old one is left alone underneath it.
      return { from: {}, to: { clipPath: `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)` } }
    case 'wipeRight':
      return { from: {}, to: { clipPath: `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)` } }
    case 'slideLeft':
      // Both move together: the incoming shot arrives from the right and pushes
      // the outgoing one off the left edge.
      return {
        from: { transform: `translateX(${(-p * 100).toFixed(2)}%)` },
        to: { transform: `translateX(${((1 - p) * 100).toFixed(2)}%)` },
      }
    case 'slideRight':
      return {
        from: { transform: `translateX(${(p * 100).toFixed(2)}%)` },
        to: { transform: `translateX(${(-(1 - p) * 100).toFixed(2)}%)` },
      }
    case 'iris':
      return {
        from: {},
        to: { clipPath: `circle(${(p * IRIS_FULL_RADIUS).toFixed(2)}% at 50% 50%)` },
      }
    case 'dissolve':
    default:
      return { from: { opacity: 1 - p }, to: { opacity: p } }
  }
}

/** Milliseconds, for the readouts — a transition is far too short to read in seconds. */
export function formatTransitionDuration(seconds: number): string {
  return `${Math.round(Math.max(0, seconds) * 1000)}ms`
}
