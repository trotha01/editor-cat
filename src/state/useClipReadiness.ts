/**
 * Where the preview's media elements say how ready they are, and where the
 * timeline and the transport read it back.
 *
 * It is a store rather than props because the two ends are nowhere near each
 * other: the elements live inside the preview, and what needs to show their
 * state is a lane of clip cards in a different section of the app. Threading it
 * through App would put a value that changes on every `progress` event into the
 * one component that re-renders everything.
 */
import { create } from 'zustand'
import { quantise, sameReadiness, type ClipReadiness } from '../lib/readiness'

interface ClipReadinessState {
  byClip: Readonly<Record<string, ClipReadiness>>
  /** Called by the preview layer that owns the element for `clipId`. */
  report: (clipId: string, readiness: ClipReadiness) => void
  /** Called when that layer goes away, so removed clips leave no reading behind. */
  forget: (clipId: string) => void
}

export const useClipReadiness = create<ClipReadinessState>((set, get) => ({
  byClip: {},

  report: (clipId, readiness) => {
    const next = quantise(readiness)
    const current = get().byClip[clipId]
    // Media elements fire `progress` far more often than the reading actually
    // changes. Dropping the identical ones keeps playback from re-rendering the
    // timeline several times a second for no visible difference.
    if (current && sameReadiness(current, next)) return
    set((state) => ({ byClip: { ...state.byClip, [clipId]: next } }))
  },

  forget: (clipId) => {
    if (!(clipId in get().byClip)) return
    set((state) => {
      const byClip = { ...state.byClip }
      delete byClip[clipId]
      return { byClip }
    })
  },
}))
