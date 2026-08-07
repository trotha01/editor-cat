/**
 * The idea being worked on: one word, one language, one sentence.
 *
 * This lives in a store rather than in the panel because the panel is unmounted
 * every time you change tab. Local state would mean that stepping over to Image
 * to look at something and coming back threw away the sentence you were halfway
 * through — and unlike a prompt, an idea is meant to outlive the tab it was
 * written on. Persisting it is the same argument extended over a reload.
 *
 * The picked word is deliberately *not* persisted: it points into a particular
 * tokenisation of the sentence, and restoring it later risks highlighting a
 * word that has since moved or gone.
 */
import { create } from 'zustand'
import { DEFAULT_LANGUAGE } from '../lib/idea'

const STORAGE_KEY = 'editor-cat.idea.v1'

interface Idea {
  word: string
  language: string
  sentence: string
}

const EMPTY: Idea = { word: '', language: DEFAULT_LANGUAGE, sentence: '' }

/** Pure, and exported for tests: whatever was stored in, a usable idea out. */
export function readIdea(stored: unknown): Idea {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...EMPTY }

  const source = stored as Partial<Idea>
  const idea = { ...EMPTY }
  for (const key of Object.keys(EMPTY) as (keyof Idea)[]) {
    const value = source[key]
    if (typeof value === 'string') idea[key] = value
  }
  return idea
}

function load(): Idea {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? readIdea(JSON.parse(raw)) : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

function persist(idea: Idea): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(idea))
  } catch {
    // Storage may be unavailable. An idea is not worth failing over.
  }
}

interface IdeaState extends Idea {
  /**
   * Index into `tokenize(sentence)` of the word new ideas are built from, or
   * null when nothing is picked.
   */
  focus: number | null
  setWord: (word: string) => void
  setLanguage: (language: string) => void
  setSentence: (sentence: string) => void
  setFocus: (focus: number | null) => void
}

export const useIdeaStore = create<IdeaState>((set) => {
  const write = (patch: Partial<Idea>) =>
    set((state) => {
      const next = {
        word: state.word,
        language: state.language,
        sentence: state.sentence,
        ...patch,
      }
      persist(next)
      return next
    })

  return {
    ...load(),
    focus: null,

    setWord: (word) => write({ word }),
    setLanguage: (language) => write({ language }),

    // Editing the sentence renumbers its tokens, so whatever was picked before
    // is no longer reliably the same word. Dropping it is the honest answer.
    setSentence: (sentence) => {
      write({ sentence })
      set({ focus: null })
    },

    setFocus: (focus) => set({ focus }),
  }
})
