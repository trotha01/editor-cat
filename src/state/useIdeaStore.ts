/**
 * The Idea tab's brainstormed word, prompt, count, ideas and error, kept
 * outside the panel.
 *
 * Switching tabs unmounts the panel components (see `App.tsx`), so state that
 * lived in `useState` here was gone the moment someone glanced at another tab
 * and came back — losing 20 generated ideas to a stray click. Living in a
 * store instead survives the unmount the same way a caption or audio-fix job
 * does, even though nothing here runs in the background past the request. A
 * hand-edited prompt is the most expensive thing on the tab to lose, so it
 * belongs here for the same reason.
 */
import { create } from 'zustand'
import {
  buildIdeaSystemPrompt,
  DEFAULT_IDEA_COUNT,
  MAX_IDEA_COUNT,
  MIN_IDEA_COUNT,
  generateIdeas,
} from '../lib/ideaGenerator'
import { toDisplayMessage } from '../lib/errors'

interface IdeaState {
  word: string
  setWord: (word: string) => void
  count: number
  setCount: (count: number) => void
  prompt: string
  setPrompt: (prompt: string) => void
  resetPrompt: () => void
  ideas: string[] | null
  busy: boolean
  error: string | null
  setError: (error: string | null) => void
  generate: () => Promise<void>
}

export const useIdeaStore = create<IdeaState>((set, get) => ({
  word: '',
  setWord: (word) => set({ word }),

  count: DEFAULT_IDEA_COUNT,

  /**
   * Changing the count rewrites the prompt — but only while the prompt is
   * still the generated one. Once it has been edited by hand, the count box
   * stops touching it: silently rewording someone's prompt out from under
   * them is worse than the two numbers disagreeing, and "Reset prompt" is
   * right there for whoever wants the stock wording back.
   */
  setCount: (count) => {
    const next = Math.min(MAX_IDEA_COUNT, Math.max(MIN_IDEA_COUNT, Math.round(count)))
    const { count: current, prompt } = get()
    if (next === current) return
    set({
      count: next,
      ...(prompt === buildIdeaSystemPrompt(current) ? { prompt: buildIdeaSystemPrompt(next) } : {}),
    })
  },

  prompt: buildIdeaSystemPrompt(DEFAULT_IDEA_COUNT),
  setPrompt: (prompt) => set({ prompt }),
  resetPrompt: () => set({ prompt: buildIdeaSystemPrompt(get().count) }),

  ideas: null,
  busy: false,
  error: null,
  setError: (error) => set({ error }),

  generate: async () => {
    const { word, count, prompt } = get()
    if (!word.trim() || get().busy) return
    set({ busy: true, error: null, ideas: null })
    try {
      set({ ideas: await generateIdeas({ word, count, systemPrompt: prompt }) })
    } catch (cause) {
      set({ error: toDisplayMessage(cause) })
    } finally {
      set({ busy: false })
    }
  },
}))
