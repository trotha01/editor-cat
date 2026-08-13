/**
 * Words, and the videos that teach them.
 *
 * A different shape of work from the timeline: nothing here is trimmed, mixed or
 * rendered. A word is a small ordered run of whole takes — a lead-in, the word
 * itself, a sign-off — kept together so they can be watched as one thing and
 * shipped as one thing. So the model is deliberately thin: a list, an order, and
 * a label on each entry saying what it is doing there.
 *
 * Everything in here is pure, and the store on top of it (state/useWordsStore.ts)
 * is what writes the results to IndexedDB. The split is the same one the timeline
 * makes: reordering a list is arithmetic worth testing directly, and it should
 * not need a database to be asked about.
 */
import { newId } from './media'
import { reorder } from './timeline'

/**
 * What a video is doing in a word's run.
 *
 * `word` is the plain take of the word being said, and it is the only one a
 * word genuinely needs — the other two are the wrapper you put around it, and a
 * word may have any number of all three. The label is only ever a label: the
 * order videos play in is the order they are listed in, and nothing here
 * reshuffles a run to put the intro first. Somebody who wants the outro in the
 * middle for a moment gets to have it there.
 */
export type WordVideoRole = 'intro' | 'word' | 'outro'

/** The roles, in the order they are offered. */
export const ROLES: { id: WordVideoRole; label: string; hint: string }[] = [
  { id: 'intro', label: 'Intro', hint: 'Leads in to the word' },
  { id: 'word', label: 'Word', hint: 'The word itself' },
  { id: 'outro', label: 'Outro', hint: 'Signs off after it' },
]

/**
 * What an upload is until somebody says otherwise.
 *
 * The word itself, because that is what most of these are and what the page is
 * for. Guessing from the order files arrive in — first one is the intro, last
 * one the outro — would be right often enough to be trusted and wrong often
 * enough to hurt.
 */
export const DEFAULT_ROLE: WordVideoRole = 'word'

export function roleLabel(role: WordVideoRole): string {
  return ROLES.find((entry) => entry.id === role)?.label ?? role
}

/** One take, pointing at the bytes in the asset catalogue. */
export interface WordVideo {
  id: string
  /** The file in the catalogue. The bytes themselves live in IndexedDB. */
  assetId: string
  role: WordVideoRole
  /**
   * What is said in it, typed by hand. Absent until somebody writes one, which
   * is different from an empty string only in that nothing was ever there.
   */
  transcript?: string
}

/** A word, with its videos in the order they play. */
export interface Word {
  id: string
  languageId: string
  text: string
  videos: WordVideo[]
  createdAt: number
}

export interface Language {
  id: string
  name: string
  createdAt: number
}

export function newLanguage(name: string): Language {
  return { id: newId('lang'), name: name.trim(), createdAt: Date.now() }
}

export function newWord(languageId: string, text: string): Word {
  return { id: newId('word'), languageId, text: text.trim(), videos: [], createdAt: Date.now() }
}

export function newWordVideo(assetId: string, role: WordVideoRole = DEFAULT_ROLE): WordVideo {
  return { id: newId('wv'), assetId, role }
}

/**
 * Both navigation lists are sorted by name rather than by when they were added.
 *
 * A list you are navigating is a list you are looking things up in, and two
 * hundred words in the order somebody happened to record them is not a list you
 * can look anything up in. Adding one still puts you straight into it — the page
 * selects what it just made — so where it lands in the column costs nothing.
 */
export function sortedLanguages(languages: readonly Language[]): Language[] {
  return [...languages].sort((a, b) => a.name.localeCompare(b.name))
}

/** The words of one language, sorted the same way. Empty when none is chosen. */
export function wordsInLanguage(words: readonly Word[], languageId: string | null): Word[] {
  if (!languageId) return []
  return words
    .filter((word) => word.languageId === languageId)
    .sort((a, b) => a.text.localeCompare(b.text))
}

/**
 * Comparing the names people type, rather than the names they meant.
 *
 * "Spanish" and "spanish " are the same language, and a page that holds both is
 * a page where half your work is filed under a stray capital. So an add that
 * matches something already there selects it instead of making a second one.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0
}

export function findLanguage(languages: readonly Language[], name: string): Language | undefined {
  return languages.find((language) => sameName(language.name, name))
}

export function findWord(
  words: readonly Word[],
  languageId: string,
  text: string,
): Word | undefined {
  return words.find((word) => word.languageId === languageId && sameName(word.text, text))
}

export function withVideo(word: Word, video: WordVideo): Word {
  return { ...word, videos: [...word.videos, video] }
}

export function withoutVideo(word: Word, videoId: string): Word {
  return { ...word, videos: word.videos.filter((video) => video.id !== videoId) }
}

/** Moves a video to another place in the run. Out-of-range indices are no-ops. */
export function withMovedVideo(word: Word, from: number, to: number): Word {
  return { ...word, videos: reorder(word.videos, from, to) }
}

/** Changes one video's label or transcript, leaving the rest of the run alone. */
export function withVideoPatch(
  word: Word,
  videoId: string,
  patch: Partial<Omit<WordVideo, 'id'>>,
): Word {
  return {
    ...word,
    videos: word.videos.map((video) => (video.id === videoId ? { ...video, ...patch } : video)),
  }
}

/**
 * Whether nothing left on this page still wants a file's bytes.
 *
 * The counterpart of `isAssetOrphaned` for the library, and it can afford to be
 * a smaller question: a video uploaded here is put in the catalogue without
 * joining any project's library (see `adopt` in state/useAssetStore.ts), so no
 * timeline can be pointing at it. The words are the whole of what could be.
 */
export function isVideoAssetOrphaned(assetId: string, words: readonly Word[]): boolean {
  return !words.some((word) => word.videos.some((video) => video.assetId === assetId))
}
