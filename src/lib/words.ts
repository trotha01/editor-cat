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
    return [{ id: tier.id, name: tier.name, createdAt: stamp(tier.createdAt), ...folder(tier) }]
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
        ...folder(language),
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
        ...folder(word),
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

function folder(entry: { driveFolderId?: unknown }): { driveFolderId?: string } {
  return isId(entry.driveFolderId) ? { driveFolderId: entry.driveFolderId } : {}
}

/**
 * Folds what the account holds into what this browser had.
 *
 * The account's copy is the shelf. This browser's copy is a cache of it, so a
 * read replaces what it has rather than adding to it — which is the only way a
 * word deleted on a laptop can stay deleted on the desktop, and the reason this
 * is a different operation from `mergeShelf` below, which folds in a folder tree
 * that has no idea what has been deleted.
 *
 * With one exception, and it is the one that matters: anything made here since
 * the last successful write is kept, and on a browser that has never had one,
 * everything local is. That is work the account has not been told about yet — a
 * word added on a train, a tier added while the connection was down, a shelf
 * that predates the account having shelves at all — and treating the server's
 * silence about it as a deletion would throw it away. Anything older than the
 * last sync has been up there, and can be trusted to be missing on purpose.
 *
 * What this does not merge is two machines editing the same word at once: the
 * account's copy of an entry wins over this browser's. Edits reach the server a
 * beat after they are made, so the window is seconds wide, and the alternative —
 * a field-by-field merge of a document nobody stamped — is guesswork.
 */
export function mergeRemoteShelf(remote: Shelf, local: Shelf, syncedAt: number): Shelf {
  const withFresh = <T extends { id: string; createdAt: number; driveFolderId?: string }>(
    theirs: T[],
    ours: T[],
  ): T[] => {
    const ids = new Set(theirs.map((entry) => entry.id))
    const folders = new Set(
      theirs.flatMap((entry) => (entry.driveFolderId ? [entry.driveFolderId] : [])),
    )

    // A shelf that has never been up there is entirely unsent, whatever the
    // timestamps say — which is what makes the first sync of a browser that has
    // been using the page for months an addition rather than a wipe.
    const unsent = (entry: T) => syncedAt === 0 || entry.createdAt >= syncedAt

    // By folder as well as by id, because the same tier can honestly have two
    // ids: two machines that each built their first shelf out of the same Drive
    // folders made their own rows for it, and matching only on id would put both
    // in the column.
    const missing = (entry: T) =>
      !ids.has(entry.id) && !(entry.driveFolderId && folders.has(entry.driveFolderId))

    return [...theirs, ...ours.filter((entry) => missing(entry) && unsent(entry))]
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

/*
 * ---------------------------------------------------------------------------
 * The shelf as Google Drive holds it.
 *
 * A folder per language, a folder per word inside it, and that word's videos in
 * that folder — which is the layout somebody would build by hand, and is the
 * whole point: the shelf is legible in Drive without this app, and the files are
 * where you would go looking for them from a phone.
 *
 * The folders hold the videos and nothing else now: the order, the labels and
 * the transcripts are the account's (see above). What is left here is reading a
 * shelf *out* of Drive, which happens exactly once per account — when there is
 * no shelf on the account yet and the folders are all there is to go on, as they
 * are for anybody who used the app before this moved. That read still
 * understands the old `editor-cat.json`, because it is where the order and the
 * labels are for exactly as long as it takes to write them up. Nothing writes
 * one any more.
 *
 * With one limit worth knowing, because it looks like a bug from the outside:
 * this app sees the files it made and the ones handed to it through the Picker,
 * and nothing else in anybody's Drive. So a video dropped into a word folder
 * from a phone is really there and still invisible here, until it is picked —
 * which is what "Add from Drive" on the word page is for.
 *
 * Everything below is the pure half of that: what the old file says, and how to
 * reconcile a folder tree with what this browser already had. The Drive calls
 * themselves are in lib/wordsDrive.ts.
 * ---------------------------------------------------------------------------
 */

/** What the old sidecar is called in every word folder. Read, never written. */
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
        // Anything that is not one of the three reads as no label rather than as
        // the default one: an unlabelled take is a thing somebody can mean now,
        // so guessing on their behalf would put a word back that they took off.
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
 * a take uploaded from another machine, or just handed over through the Picker,
 * joins the end of the run rather than being ignored. A take the sidecar names
 * takes its label and transcript from there,
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
    // Both taken from the sidecar wholesale where it names the take, absences
    // included: a label somebody removed on another machine is written down as
    // an absence, and falling back to what this browser still had would be how
    // it came back.
    const transcript = entry ? entry.transcript : existing?.transcript
    const role = entry ? entry.role : existing?.role
    run.push({
      // Kept where there is one, so a sync mid-edit does not pull the row out
      // from under a cursor that is in its transcript box.
      id: existing?.id ?? newId('wv'),
      assetId: discovered.assetId,
      ...(role ? { role } : {}),
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
