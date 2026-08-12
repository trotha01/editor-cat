/**
 * The Idea tab's brainstormed word, ideas and error, kept outside the panel.
 *
 * Switching tabs unmounts the panel components (see `App.tsx`), so state that
 * lived in `useState` here was gone the moment someone glanced at another tab
 * and came back — losing 20 generated ideas to a stray click. Living in a
 * store instead survives the unmount the same way a caption or audio-fix job
 * does, even though nothing here runs in the background past the request.
 */
import { create } from 'zustand'
import { generateIdeas } from '../lib/ideaGenerator'
import { toDisplayMessage } from '../lib/errors'

interface IdeaState {
  word: string
  setWord: (word: string) => void
  ideas: string[] | null
  busy: boolean
  error: string | null
  setError: (error: string | null) => void
  generate: () => Promise<void>
}

export const useIdeaStore = create<IdeaState>((set, get) => ({
  word: '',
  setWord: (word) => set({ word }),
  ideas: null,
  busy: false,
  error: null,
  setError: (error) => set({ error }),

  generate: async () => {
    const word = get().word
    if (!word.trim() || get().busy) return
    set({ busy: true, error: null, ideas: null })
    try {
      set({ ideas: await generateIdeas({ word }) })
    } catch (cause) {
      set({ error: toDisplayMessage(cause) })
    } finally {
      set({ busy: false })
    }
  },
}))
