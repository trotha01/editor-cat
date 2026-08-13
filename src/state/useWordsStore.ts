/**
 * The word pages: the languages, the words under them, and which of each is
 * being looked at.
 *
 * Every change writes straight through to IndexedDB, the way the project store
 * does and for the same reason — somebody who has just uploaded and labelled
 * twenty takes should not lose the labels to a closed tab. The videos themselves
 * are in the asset catalogue and their bytes in the blob store, so what is kept
 * here is small: names, an order, and a line of transcript each.
 *
 * Local to this browser, and that is the current limit of it. The bytes reach
 * Google Drive through the ingest hook like everything else the app takes in,
 * but the lists below do not sync to an account the way a timeline does.
 */
import { create } from 'zustand'
import {
  deleteLanguage as dbDeleteLanguage,
  deleteWord as dbDeleteWord,
  listLanguages,
  listWords,
  putLanguage,
  putWord,
} from '../lib/db'
import {
  findLanguage,
  findWord,
  isVideoAssetOrphaned,
  newLanguage,
  newWord,
  newWordVideo,
  sortedLanguages,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type Language,
  type Word,
  type WordVideoRole,
} from '../lib/words'
import { useAssetStore } from './useAssetStore'

interface WordsState {
  languages: Language[]
  words: Word[]
  /** Null before anything has been added, and while the first read is running. */
  selectedLanguageId: string | null
  selectedWordId: string | null
  loading: boolean
  /** Set once the stores have been read, so a second visit keeps its selection. */
  loaded: boolean

  /** Reads both stores. Does nothing on a page that has already been opened. */
  load: () => Promise<void>

  /** Adds a language, or selects the one already under that name. */
  addLanguage: (name: string) => void
  selectLanguage: (id: string | null) => void
  /** Deletes a language, its words, and any video bytes left with nothing to reach them. */
  removeLanguage: (id: string) => Promise<void>

  /** Adds a word to the selected language, or selects the one already there. */
  addWord: (text: string) => void
  selectWord: (id: string | null) => void
  removeWord: (id: string) => Promise<void>

  /** Puts an uploaded video on the end of a word's run, labelled as the word itself. */
  addVideo: (wordId: string, assetId: string) => void
  setVideoRole: (wordId: string, videoId: string, role: WordVideoRole) => void
  setTranscript: (wordId: string, videoId: string, transcript: string) => void
  moveVideo: (wordId: string, from: number, to: number) => void
  removeVideo: (wordId: string, videoId: string) => Promise<void>

  selectedWord: () => Word | undefined
}

function persistWord(word: Word): void {
  void putWord(word).catch(() => {
    // Best-effort, like the project store: losing the write must not lose the
    // edit that is already on screen.
  })
}

function persistLanguage(language: Language): void {
  void putLanguage(language).catch(() => {})
}

/**
 * Deletes the bytes behind videos nothing lists any more.
 *
 * Called after the words have already changed, and judged against the words as
 * they are then — deleting a word that shared a take with another word leaves
 * the take alone, because the other word still plays it. What is never touched
 * is the copy in the user's Drive, which is theirs and was backed up on the way
 * in; this is only the local cache of it.
 */
function forgetOrphanedAssets(assetIds: readonly string[], words: readonly Word[]): Promise<void> {
  const gone = [...new Set(assetIds)].filter((id) => isVideoAssetOrphaned(id, words))
  return Promise.all(gone.map((id) => useAssetStore.getState().remove(id)))
    .then(() => {})
    .catch(() => {
      // The video is out of the word either way, which is what was asked for.
      // What is left behind is bytes nobody can see, and Settings can clear those.
    })
}

/** Every asset a run of words points at, for working out what a delete strands. */
function assetIdsOf(words: readonly Word[]): string[] {
  return words.flatMap((word) => word.videos.map((video) => video.assetId))
}

export const useWordsStore = create<WordsState>((set, get) => ({
  languages: [],
  words: [],
  selectedLanguageId: null,
  selectedWordId: null,
  loading: true,
  loaded: false,

  load: async () => {
    // Leaving the page and coming back to it should come back to what was open,
    // and re-reading would put the selection back to the top of both columns.
    if (get().loaded) return
    set({ loading: true })
    try {
      const [languages, words] = await Promise.all([listLanguages(), listWords()])
      // Opening on the first language and its first word, so a page that has
      // been used before opens on something rather than on two empty columns
      // and a prompt.
      const language = sortedLanguages(languages)[0]
      set({
        languages,
        words,
        loading: false,
        loaded: true,
        selectedLanguageId: language?.id ?? null,
        selectedWordId: wordsInLanguage(words, language?.id ?? null)[0]?.id ?? null,
      })
    } catch {
      // Nothing to show and nothing to be done about it from here. Not latched
      // as loaded: coming back to the page is a fair second try.
      set({ languages: [], words: [], loading: false })
    }
  },

  addLanguage: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return

    const existing = findLanguage(get().languages, trimmed)
    if (existing) {
      get().selectLanguage(existing.id)
      return
    }

    const language = newLanguage(trimmed)
    persistLanguage(language)
    set((state) => ({
      languages: [...state.languages, language],
      selectedLanguageId: language.id,
      // Nothing in it yet, so nothing to be looking at.
      selectedWordId: null,
    }))
  },

  selectLanguage: (id) => {
    set((state) => ({
      selectedLanguageId: id,
      // A language and a word from another language is not a state the page can
      // draw, so switching column one always resettles column two.
      selectedWordId: wordsInLanguage(state.words, id)[0]?.id ?? null,
    }))
  },

  /**
   * The screen changes first and storage catches up, which is the same order
   * every edit in this app is made in: nothing on screen should wait for a
   * write, and a write that fails costs the save rather than the action.
   */
  removeLanguage: async (id) => {
    const doomed = get().words.filter((word) => word.languageId === id)
    const assetIds = assetIdsOf(doomed)

    const languages = get().languages.filter((language) => language.id !== id)
    const words = get().words.filter((word) => word.languageId !== id)
    const next = sortedLanguages(languages)[0]
    set({
      languages,
      words,
      ...(get().selectedLanguageId === id
        ? {
            selectedLanguageId: next?.id ?? null,
            selectedWordId: wordsInLanguage(words, next?.id ?? null)[0]?.id ?? null,
          }
        : {}),
    })

    await Promise.all([dbDeleteLanguage(id), ...doomed.map((word) => dbDeleteWord(word.id))]).catch(
      () => {},
    )
    await forgetOrphanedAssets(assetIds, words)
  },

  addWord: (text) => {
    const languageId = get().selectedLanguageId
    const trimmed = text.trim()
    if (!languageId || !trimmed) return

    const existing = findWord(get().words, languageId, trimmed)
    if (existing) {
      set({ selectedWordId: existing.id })
      return
    }

    const word = newWord(languageId, trimmed)
    persistWord(word)
    set((state) => ({ words: [...state.words, word], selectedWordId: word.id }))
  },

  selectWord: (id) => set({ selectedWordId: id }),

  removeWord: async (id) => {
    const doomed = get().words.find((word) => word.id === id)
    if (!doomed) return

    const words = get().words.filter((word) => word.id !== id)
    set((state) => ({
      words,
      ...(state.selectedWordId === id
        ? { selectedWordId: wordsInLanguage(words, state.selectedLanguageId)[0]?.id ?? null }
        : {}),
    }))

    await dbDeleteWord(id).catch(() => {})
    await forgetOrphanedAssets(assetIdsOf([doomed]), words)
  },

  addVideo: (wordId, assetId) => {
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideo(word, newWordVideo(assetId))),
    }))
  },

  setVideoRole: (wordId, videoId, role) => {
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { role })),
    }))
  },

  setTranscript: (wordId, videoId, transcript) => {
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { transcript })),
    }))
  },

  moveVideo: (wordId, from, to) => {
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withMovedVideo(word, from, to)),
    }))
  },

  removeVideo: async (wordId, videoId) => {
    const assetId = get()
      .words.find((word) => word.id === wordId)
      ?.videos.find((video) => video.id === videoId)?.assetId

    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withoutVideo(word, videoId)),
    }))

    if (assetId) await forgetOrphanedAssets([assetId], get().words)
  },

  selectedWord: () => {
    const { words, selectedWordId } = get()
    return words.find((word) => word.id === selectedWordId)
  },
}))

/**
 * Applies a change to one word and writes the result down.
 *
 * Every edit to a word goes through here, which is what makes "each change is
 * saved" one rule rather than one per control.
 */
function mapWord(words: readonly Word[], wordId: string, change: (word: Word) => Word): Word[] {
  return words.map((word) => {
    if (word.id !== wordId) return word
    const next = change(word)
    persistWord(next)
    return next
  })
}
