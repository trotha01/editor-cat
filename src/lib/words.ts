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
  /**
   * The folder in Drive this word's videos live in, once there is one.
   *
   * Absent while Drive is not connected, or until the folder has been made —
   * which is the same thing as saying the page still works with no Google at
   * all, and links itself up when there is one.
   */
  driveFolderId?: string
}

export interface Language {
  id: string
  /** The tier this language is taught in. A language may be in more than one. */
  tierId: string
  name: string
  createdAt: number
  /** The folder in Drive holding this language's words. See `Word`. */
  driveFolderId?: string
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
  /** The folder in Drive holding this tier's languages. */
  driveFolderId?: string
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
function sameName(a: string, b: string): boolean {
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
 * The shelf as Google Drive holds it.
 *
 * A folder per language, a folder per word inside it, and that word's videos in
 * that folder — which is the layout somebody would build by hand, and is the
 * whole point: the shelf is legible in Drive without this app, and the files are
 * where you would go looking for them from a phone.
 *
 * A folder cannot hold an order, a label or a transcript, so each word folder
 * also gets one small JSON file listing its takes by Drive id. The folder still
 * says which videos there *are* — drop one in from a phone and it turns up at
 * the end of the run — and the sidecar says what they are and what order they go
 * in. Everything below is the pure half of that: what the file says, and how to
 * reconcile it with what this browser already had. The Drive calls themselves
 * are in lib/wordsDrive.ts.
 * ---------------------------------------------------------------------------
 */

/** What the sidecar is called in every word folder. */
export const SIDECAR_NAME = 'editor-cat.json'

export interface SidecarEntry {
  /** The Drive file, which is what survives being renamed or re-catalogued. */
  driveFileId: string
  role: WordVideoRole
  transcript?: string
}

export interface WordSidecar {
  version: 1
  /** The word itself, so the file makes sense opened on its own in Drive. */
  word: string
  /** The takes, in the order they play. */
  videos: SidecarEntry[]
}

/** What to write beside a word's videos. Takes with no Drive file yet are left out. */
export function buildSidecar(
  word: Word,
  driveFileIdOf: (assetId: string) => string | undefined,
): WordSidecar {
  const videos: SidecarEntry[] = []
  for (const video of word.videos) {
    const driveFileId = driveFileIdOf(video.assetId)
    // Nothing to name it by. It is either still uploading or failed to, and
    // either way the next write picks it up.
    if (!driveFileId) continue
    const transcript = video.transcript?.trim()
    videos.push({ driveFileId, role: video.role, ...(transcript ? { transcript } : {}) })
  }
  return { version: 1, word: word.text, videos }
}

/**
 * Reads a sidecar back, or gives up.
 *
 * Anything unrecognisable is treated as absent rather than as an error: the file
 * sits in the user's own Drive where it can be edited, truncated by a failed
 * write, or replaced by something else entirely, and none of that is worth
 * refusing to show a folder of videos over. What is lost is the order and the
 * labels, which the folder itself can still be read without.
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
        role: ROLES.some((role) => role.id === candidate.role)
          ? (candidate.role as WordVideoRole)
          : DEFAULT_ROLE,
        ...(typeof candidate.transcript === 'string' ? { transcript: candidate.transcript } : {}),
      })
    }
    return { version: 1, word: typeof raw.word === 'string' ? raw.word : '', videos }
  } catch {
    return null
  }
}

/** A video file found in a word's folder, with the catalogue entry for its bytes. */
export interface DiscoveredVideo {
  driveFileId: string
  assetId: string
}

export interface DiscoveredWord {
  folderId: string
  name: string
  /** The video files in the folder, in the order Drive listed them. */
  videos: DiscoveredVideo[]
  sidecar: WordSidecar | null
}

export interface DiscoveredLanguage {
  folderId: string
  name: string
  words: DiscoveredWord[]
}

export interface DiscoveredTier {
  folderId: string
  name: string
  languages: DiscoveredLanguage[]
}

/** The three lists the page is drawn from, passed around together. */
export interface Shelf {
  tiers: Tier[]
  languages: Language[]
  words: Word[]
}

/**
 * Folds what Drive holds into what this browser already had.
 *
 * Matched by folder id before name, which is what makes the three things that
 * actually happen all land where they should: a shelf opened on a second machine
 * arrives whole, a language added here while offline adopts the folder it is
 * later found to have, and nothing is duplicated by being seen twice.
 *
 * The folder tree is taken at its word in both directions. Anything with a
 * folder id that the read did not turn up has been deleted from somewhere else,
 * and goes — otherwise a word deleted on a laptop would sit on the desktop
 * forever with no way to get rid of it, which is the same resurrection problem
 * as a take that will not stay deleted, only from the other end. What is never
 * dropped is anything with no folder id at all: that is work made here that
 * Drive has not been told about yet, and its absence over there says nothing.
 *
 * A word's run of takes is rebuilt rather than merged item by item, for the same
 * reason: the question "which videos does this word have" has an answer in the
 * folder, and half-believing it is how takes come back from the dead. Local takes
 * still on their way up are the exception, again because they are not yet
 * something Drive could have an opinion about.
 */
export function mergeShelf(
  local: Shelf,
  discovered: readonly DiscoveredTier[],
  driveFileIdOf: (assetId: string) => string | undefined,
): Shelf {
  const tiers = [...local.tiers]
  const languages = [...local.languages]
  const words = [...local.words]

  // Every folder the read turned up, so that what it did not turn up can be
  // told apart from what it was never asked about.
  const seen = new Set<string>()
  for (const tier of discovered) {
    seen.add(tier.folderId)
    for (const language of tier.languages) {
      seen.add(language.folderId)
      for (const word of language.words) seen.add(word.folderId)
    }
  }

  const put = <T extends { id: string }>(list: T[], next: T) => {
    const at = list.findIndex((entry) => entry.id === next.id)
    if (at >= 0) list[at] = next
    else list.push(next)
    return next
  }

  for (const foundTier of discovered) {
    const matchedTier =
      tiers.find((entry) => entry.driveFolderId === foundTier.folderId) ??
      tiers.find((entry) => !entry.driveFolderId && sameName(entry.name, foundTier.name))

    const tier = put(tiers, {
      ...(matchedTier ?? newTier(foundTier.name)),
      driveFolderId: foundTier.folderId,
    })

    for (const found of foundTier.languages) {
      const matched =
        languages.find((entry) => entry.driveFolderId === found.folderId) ??
        // Only within this tier: the same language name under two tiers is two
        // shelves, and matching across them would merge somebody's ESL French
        // into their first-tier French.
        languages.find(
          (entry) =>
            entry.tierId === tier.id && !entry.driveFolderId && sameName(entry.name, found.name),
        )

      const language = put(languages, {
        ...(matched ?? newLanguage(tier.id, found.name)),
        tierId: tier.id,
        driveFolderId: found.folderId,
      })

      for (const foundWord of found.words) {
        const matchedWord =
          words.find((entry) => entry.driveFolderId === foundWord.folderId) ??
          words.find(
            (entry) =>
              entry.languageId === language.id &&
              !entry.driveFolderId &&
              sameName(entry.text, foundWord.name),
          )
        const word = matchedWord ?? newWord(language.id, foundWord.name)

        put(words, {
          ...word,
          languageId: language.id,
          driveFolderId: foundWord.folderId,
          videos: mergeVideos(word, foundWord, driveFileIdOf),
        })
      }
    }
  }

  // Pruned from the top down, so a tier that has gone takes its languages with
  // it and they take their words — exactly as trashing its folder in Drive took
  // everything underneath.
  const keptTiers = tiers.filter((entry) => !entry.driveFolderId || seen.has(entry.driveFolderId))
  const tierIds = new Set(keptTiers.map((entry) => entry.id))

  const keptLanguages = languages.filter(
    (entry) => tierIds.has(entry.tierId) && (!entry.driveFolderId || seen.has(entry.driveFolderId)),
  )
  const languageIds = new Set(keptLanguages.map((entry) => entry.id))

  return {
    tiers: keptTiers,
    languages: keptLanguages,
    words: words.filter(
      (entry) =>
        languageIds.has(entry.languageId) &&
        (!entry.driveFolderId || seen.has(entry.driveFolderId)),
    ),
  }
}

/**
 * One word's run, rebuilt from its folder.
 *
 * The order is the sidecar's, then whatever else is in the folder — which is how
 * a video dropped in from a phone joins the end of the run rather than being
 * ignored. A take the sidecar names takes its label and transcript from there,
 * because that file is what the machine that made the edit wrote down; one it
 * does not name keeps whatever this browser had for it.
 */
function mergeVideos(
  word: Word,
  found: DiscoveredWord,
  driveFileIdOf: (assetId: string) => string | undefined,
): WordVideo[] {
  const localByDriveId = new Map<string, WordVideo>()
  for (const video of word.videos) {
    const driveFileId = driveFileIdOf(video.assetId)
    if (driveFileId) localByDriveId.set(driveFileId, video)
  }

  const inFolder = new Map(found.videos.map((video) => [video.driveFileId, video] as const))
  const taken = new Set<string>()
  const run: WordVideo[] = []

  const take = (driveFileId: string, entry?: SidecarEntry) => {
    const discovered = inFolder.get(driveFileId)
    if (!discovered || taken.has(driveFileId)) return
    taken.add(driveFileId)

    const existing = localByDriveId.get(driveFileId)
    const transcript = entry ? entry.transcript : existing?.transcript
    run.push({
      // Kept where there is one, so a sync mid-edit does not pull the row out
      // from under a cursor that is in its transcript box.
      id: existing?.id ?? newId('wv'),
      assetId: discovered.assetId,
      role: entry?.role ?? existing?.role ?? DEFAULT_ROLE,
      ...(transcript ? { transcript } : {}),
    })
  }

  for (const entry of found.sidecar?.videos ?? []) take(entry.driveFileId, entry)
  for (const video of found.videos) take(video.driveFileId)

  // Still on their way up, so not yet anything Drive could have told us about.
  for (const video of word.videos) {
    if (!driveFileIdOf(video.assetId)) run.push(video)
  }

  return run
}
