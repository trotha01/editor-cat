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
 * Two of the three are not anybody's decision: the take at the front of a run
 * leads in to the word and the take at the back signs off after it, so `intro`
 * and `outro` are read off the order rather than stored. Drag a different take
 * to the front and it is the intro, because being first is the whole of what
 * "intro" ever meant, and a label that could disagree with the order is a label
 * that eventually does.
 *
 * `word` is the one that is a choice, and an optional one: the takes in between
 * the ends may carry it or carry nothing at all.
 */
export type WordVideoRole = 'intro' | 'word' | 'outro'

/** The roles, in the order a run wears them. */
export const ROLES: { id: WordVideoRole; label: string; hint: string }[] = [
  { id: 'intro', label: 'Intro', hint: 'First in the run, so it leads in to the word' },
  { id: 'word', label: 'Word', hint: 'The word itself' },
  { id: 'outro', label: 'Outro', hint: 'Last in the run, so it signs off after it' },
]

/**
 * What an upload is until somebody says otherwise.
 *
 * The word itself, because that is what most of these are and what the page is
 * for — and because it is the only label an upload could be given: where it
 * lands in the run decides the other two, and it lands at the end.
 */
export const DEFAULT_ROLE: WordVideoRole = 'word'

export function roleLabel(role: WordVideoRole): string {
  return ROLES.find((entry) => entry.id === role)?.label ?? role
}

/** Why a take carries that label, for the tooltip on it. */
export function roleHint(role: WordVideoRole): string {
  return ROLES.find((entry) => entry.id === role)?.hint ?? ''
}

/**
 * What a take is labelled, given where it sits in the run.
 *
 * The ends answer for themselves. A run of one is neither end: a take that is at
 * once the first and the last is not leading in to or signing off after
 * anything, it is just the word. And in the middle only `word` still speaks —
 * a take that was the intro until something else took the front is no longer
 * introducing anything, so its stored label goes quiet rather than contradicting
 * the two ends.
 */
export function roleInRun(
  video: WordVideo,
  index: number,
  count: number,
): WordVideoRole | undefined {
  if (count > 1 && index === 0) return 'intro'
  if (count > 1 && index === count - 1) return 'outro'
  return video.role === 'word' ? 'word' : undefined
}

/** One take, pointing at the bytes in the asset catalogue. */
export interface WordVideo {
  id: string
  /** The file in the catalogue. The bytes themselves live in IndexedDB. */
  assetId: string
  /**
   * The label somebody put on it, if they put one on it. Only ever `word` in
   * practice — see `roleInRun`, which is what anything drawing a run should ask
   * — but a run restored from a machine that labelled by hand may still hold an
   * `intro` or an `outro`, and those read as no label once they are not at an
   * end.
   */
  role?: WordVideoRole
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
  /** The tier this language is taught in. A language may be in more than one. */
  tierId: string
  name: string
  createdAt: number
}

/**
 * The top of the shelf: a course, a level, a programme — whatever a set of
 * languages is being taught as. "1st tier", "2nd tier", "Classical", "ESL".
 *
 * A level of its own rather than a field on the language, because the same
 * language is taught in several of them and its words are not the same words.
 * French in the first tier and French in ESL are two shelves that happen to
 * share a name, and the folder tree says so.
 */
export interface Tier {
  id: string
  name: string
  createdAt: number
}

export function newTier(name: string): Tier {
  return { id: newId('tier'), name: name.trim(), createdAt: Date.now() }
}

export function newLanguage(tierId: string, name: string): Language {
  return { id: newId('lang'), tierId, name: name.trim(), createdAt: Date.now() }
}

export function newWord(languageId: string, text: string): Word {
  return { id: newId('word'), languageId, text: text.trim(), videos: [], createdAt: Date.now() }
}

export function newWordVideo(assetId: string, role: WordVideoRole = DEFAULT_ROLE): WordVideo {
  return { id: newId('wv'), assetId, role }
}

/**
 * All three navigation lists are sorted by name rather than by when they were
 * added.
 *
 * A list you are navigating is a list you are looking things up in, and two
 * hundred words in the order somebody happened to record them is not a list you
 * can look anything up in. Adding one still puts you straight into it — the page
 * selects what it just made — so where it lands in the column costs nothing.
 */
export function sortedTiers(tiers: readonly Tier[]): Tier[] {
  return [...tiers].sort((a, b) => a.name.localeCompare(b.name))
}

/** The languages of one tier, sorted. Empty when no tier is chosen. */
export function languagesInTier(languages: readonly Language[], tierId: string | null): Language[] {
  if (!tierId) return []
  return languages
    .filter((language) => language.tierId === tierId)
    .sort((a, b) => a.name.localeCompare(b.name))
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
export function sameName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0
}

export function findTier(tiers: readonly Tier[], name: string): Tier | undefined {
  return tiers.find((tier) => sameName(tier.name, name))
}

/** A language of that name in that tier. French in ESL is not French in 1st tier. */
export function findLanguage(
  languages: readonly Language[],
  tierId: string,
  name: string,
): Language | undefined {
  return languages.find((language) => language.tierId === tierId && sameName(language.name, name))
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

/*
 * ---------------------------------------------------------------------------
 * The shelf as the account holds it.
 *
 * One document per person — the three lists exactly as the page draws them —
 * kept in Supabase beside the projects (lib/supabase/shelf.ts, and
 * supabase/migrations/0009_word_shelf.sql for why it is a document rather than
 * four tables).
 *
 * This is where the order, the labels and the transcripts live now. They used to
 * be a small JSON file in every word folder in Drive, because a folder can hold
 * files and cannot hold an order — which worked, and left a file in every folder
 * somebody opens on their phone, and cost a listing and a download per word
 * before a shelf could be drawn. The folders are still the shelf and still hold
 * the videos; what a folder was never able to say is said here instead, in one
 * read.
 * ---------------------------------------------------------------------------
 */

/** The whole shelf as one value: what is stored, and what comes back. */
export interface ShelfDoc {
  version: 1
  tiers: Tier[]
  languages: Language[]
  words: Word[]
}

export function buildShelfDoc(shelf: Shelf): ShelfDoc {
  return { version: 1, tiers: shelf.tiers, languages: shelf.languages, words: shelf.words }
}

/**
 * The whole shelf, as one value.
 *
 * Three flat lists rather than a tree, because that is how every screen wants
 * it: a tier list, the languages under the selected tier, the words under the
 * selected language. Nesting would make every read a walk.
 */
export interface Shelf {
  tiers: Tier[]
  languages: Language[]
  words: Word[]
}

/**
 * Reads a stored shelf back, keeping whatever of it makes sense.
 *
 * Defensive in the same way `parseSidecar` is, and for a related reason: this
 * document may have been written by a version of the app that is ahead of this
 * one, or by one that is behind it. An entry missing the fields that make it an
 * entry is dropped rather than allowed to become a row on screen with no name
 * and no id; a shelf that is not a shelf at all reads as an empty one, which is
 * the same thing a fresh account is.
 */
export function parseShelfDoc(value: unknown): Shelf {
  const raw = (value ?? {}) as Partial<ShelfDoc>

  const tiers = list(raw.tiers).flatMap((entry) => {
    const tier = entry as Partial<Tier>
    if (!isId(tier.id) || typeof tier.name !== 'string') return []
    return [{ id: tier.id, name: tier.name, createdAt: stamp(tier.createdAt) }]
  })

  const languages = list(raw.languages).flatMap((entry) => {
    const language = entry as Partial<Language>
    if (!isId(language.id) || !isId(language.tierId) || typeof language.name !== 'string') return []
    return [
      {
        id: language.id,
        tierId: language.tierId,
        name: language.name,
        createdAt: stamp(language.createdAt),
      },
    ]
  })

  const words = list(raw.words).flatMap((entry) => {
    const word = entry as Partial<Word>
    if (!isId(word.id) || !isId(word.languageId) || typeof word.text !== 'string') return []
    return [
      {
        id: word.id,
        languageId: word.languageId,
        text: word.text,
        videos: list(word.videos).flatMap((raw) => {
          const video = raw as Partial<WordVideo>
          if (!isId(video.id) || !isId(video.assetId)) return []
          const transcript = typeof video.transcript === 'string' ? video.transcript : undefined
          return [
            {
              id: video.id,
              assetId: video.assetId,
              role: ROLES.some((role) => role.id === video.role) ? video.role! : DEFAULT_ROLE,
              ...(transcript ? { transcript } : {}),
            },
          ]
        }),
        createdAt: stamp(word.createdAt),
      },
    ]
  })

  return { tiers, languages, words }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A missing timestamp is treated as old, never as "just made here". See `mergeRemoteShelf`. */
function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Folds what the account holds into what this browser had.
 *
 * The account's copy is the shelf. This browser's copy is a cache of it, so a
 * read replaces what it has rather than adding to it — which is the only way a
 * word deleted on a laptop can stay deleted on the desktop.
 *
 * With one exception, and it is the one that matters: anything made here since
 * the last successful write is kept, and on a browser that has never had one,
 * everything local is. That is work the account has not been told about yet — a
 * word added on a train, a tier added while the connection was down — and
 * treating the server's silence about it as a deletion would throw it away.
 * Anything older than the last sync has been up there, and can be trusted to be
 * missing on purpose.
 *
 * What this does not merge is two machines editing the same word at once: the
 * account's copy of an entry wins over this browser's. Edits reach the server a
 * beat after they are made, so the window is seconds wide, and the alternative —
 * a field-by-field merge of a document nobody stamped — is guesswork.
 */
export function mergeRemoteShelf(remote: Shelf, local: Shelf, syncedAt: number): Shelf {
  const withFresh = <T extends { id: string; createdAt: number }>(theirs: T[], ours: T[]): T[] => {
    const ids = new Set(theirs.map((entry) => entry.id))

    // A shelf that has never been up there is entirely unsent, whatever the
    // timestamps say — which is what makes the first sync of a browser that has
    // been using the page for months an addition rather than a wipe.
    const unsent = (entry: T) => syncedAt === 0 || entry.createdAt >= syncedAt

    return [...theirs, ...ours.filter((entry) => !ids.has(entry.id) && unsent(entry))]
  }

  // Top down, so a tier that has gone takes its languages with it and they take
  // their words — including anything kept as fresh underneath something that
  // the account no longer has.
  const tiers = withFresh(remote.tiers, local.tiers)
  const tierIds = new Set(tiers.map((tier) => tier.id))

  const languages = withFresh(remote.languages, local.languages).filter((language) =>
    tierIds.has(language.tierId),
  )
  const languageIds = new Set(languages.map((language) => language.id))

  return {
    tiers,
    languages,
    words: withFresh(remote.words, local.words).filter((word) => languageIds.has(word.languageId)),
  }
}

/**
 * The sidecar the word pages used to keep beside a folder's videos.
 *
 * Read, never written. Nothing has produced one since the shelf moved onto the
 * account, and `word_shelves.doc` is the record now — but the ones already
 * sitting in people's Drive folders still say which take came first and what it
 * was labelled, and that is exactly what recovery needs when it has to pair a
 * word's takes back up with its files. See `lib/r2/recoverShelf.ts`.
 */
export const SIDECAR_NAME = 'editor-cat.json'

export interface SidecarEntry {
  /** The Drive file, which is what survives being renamed or re-catalogued. */
  driveFileId: string
  /** Absent for an unlabelled take, exactly as on the take itself. */
  role?: WordVideoRole
  transcript?: string
}

export interface WordSidecar {
  version: 1
  /** The word itself, so the file makes sense opened on its own in Drive. */
  word: string
  /** The takes, in the order they play. */
  videos: SidecarEntry[]
}

/**
 * Reads an old sidecar, or gives up.
 *
 * Anything unrecognisable is treated as absent rather than as an error: the
 * file sits in the user's own Drive where it can be edited, truncated by a
 * failed write, or replaced by something else entirely, and none of that is
 * worth refusing to read a folder of videos over. What is lost is the order and
 * the labels, which the folder itself can still be read without.
 */
export function parseSidecar(text: string): WordSidecar | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const raw = parsed as Partial<WordSidecar>
    if (!Array.isArray(raw.videos)) return null

    const videos: SidecarEntry[] = []
    for (const entry of raw.videos as unknown[]) {
      if (!entry || typeof entry !== 'object') continue
      const candidate = entry as Partial<SidecarEntry>
      if (typeof candidate.driveFileId !== 'string' || !candidate.driveFileId) continue
      videos.push({
        driveFileId: candidate.driveFileId,
        // Anything that is not one of the three reads as no label rather than
        // as the default one: an unlabelled take is a thing somebody can mean.
        ...(ROLES.some((role) => role.id === candidate.role)
          ? { role: candidate.role as WordVideoRole }
          : {}),
        ...(typeof candidate.transcript === 'string' ? { transcript: candidate.transcript } : {}),
      })
    }
    return { version: 1, word: typeof raw.word === 'string' ? raw.word : '', videos }
  } catch {
    return null
  }
}
