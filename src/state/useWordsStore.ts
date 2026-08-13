/**
 * The word pages: the tiers, the languages under them, the words under those,
 * and which of each is being looked at.
 *
 * Every change writes straight through to IndexedDB, the way the project store
 * does and for the same reason — somebody who has just uploaded and labelled
 * twenty takes should not lose the labels to a closed tab. The videos themselves
 * are in the asset catalogue and their bytes in the blob store, so what is kept
 * here is small: names, an order, and a line of transcript each.
 *
 * The shelf itself — the three lists, in one document — belongs to the account
 * (lib/supabase/shelf.ts). Every edit here writes to IndexedDB now and up to
 * that document a beat later, so what this browser holds is a cache of something
 * an account has, and a second machine reads the whole shelf in one query rather
 * than starting empty.
 *
 * And the same shelf is a tree of folders in the user's Drive: one per tier, one
 * per language inside it, one per word inside that, and that word's videos in
 * the word folder. That is where the *files* live and what makes the shelf
 * legible in Drive without this app. It is kept in step from here — every tier,
 * language and word gets its folder as it is made, every upload goes into the
 * folder for its word, every delete trashes what it was — but it is no longer
 * what the page is drawn from, and nothing writes a sidecar into it any more.
 * The folders are read exactly once per account, to build the first shelf for
 * somebody who has one in Drive from before this moved.
 *
 * Nothing here needs Drive to work: with no connection the folder ids are simply
 * absent, and the page is the local one it was before. Nothing needs an account
 * either — signed out, or on a deployment with no Supabase, the shelf is this
 * browser's alone and every write above still happens.
 *
 * And every edit is a step somebody can take back, the same as the editor's. The
 * three lists are one document here exactly as they are on the account, so a
 * step is a picture of the whole shelf and an undo is putting one back — on
 * screen, in IndexedDB, up to the account, and, for what a delete put in the
 * bin, back out of it in Drive.
 */
import { create } from 'zustand'
import {
  deleteLanguage as dbDeleteLanguage,
  deleteTier as dbDeleteTier,
  deleteWord as dbDeleteWord,
  getAsset,
  listLanguages,
  listTiers,
  listWords,
  putAsset,
  putLanguage,
  putTier,
  putWord,
} from '../lib/db'
import {
  buildShelfDoc,
  findLanguage,
  findTier,
  findWord,
  isVideoAssetOrphaned,
  languagesInTier,
  mergeRemoteShelf,
  mergeShelf,
  newLanguage,
  newTier,
  newWord,
  newWordVideo,
  parseShelfDoc,
  sameName,
  sortedTiers,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type DiscoveredTier,
  type Language,
  type Shelf,
  type Tier,
  type Word,
  type WordVideoRole,
} from '../lib/words'
import { findOrCreateFolder, readShelf, type RawTier } from '../lib/wordsDrive'
import { moveFile, renameFile, trashFile, untrashFile, type DriveFile } from '../lib/google/drive'
import { fromRow, getAssets } from '../lib/supabase/assets'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { getShelf, putShelf } from '../lib/supabase/shelf'
import { createScheduler } from '../lib/sync/scheduler'
import { recordAsset } from '../lib/sync/assetSync'
import { ingestBlob, newId } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { isSignedIn } from './useAuthStore'
import { useAssetStore } from './useAssetStore'
import { useDriveStore } from './useDriveStore'
import type { Asset } from '../lib/types'

interface WordsState {
  tiers: Tier[]
  languages: Language[]
  words: Word[]
  /** Null before anything has been added, and while the first read is running. */
  selectedTierId: string | null
  selectedLanguageId: string | null
  selectedWordId: string | null
  loading: boolean
  /** Set once the stores have been read, so a second visit keeps its selection. */
  loaded: boolean
  /** True while the shelf is being read off the account. */
  syncing: boolean
  /** Why the last read or write failed, if it did. The local shelf still stands. */
  syncError: string | null
  /**
   * The batch of files being filed into a word right now — which word, and how
   * many of them are in.
   *
   * Here rather than in the component that started it because there are two
   * doors in: the button over the videos, and a drop onto a word in the column
   * beside them. One of them is not on screen while the other is running, and
   * progress that lived in whichever component took the drop would be progress
   * you could lose by looking away.
   */
  uploading: { wordId: string; done: number; total: number } | null
  /** Why the last batch could not be filed, until the next one starts. */
  uploadError: string | null

  /**
   * Shelves the edits made here moved on from, most recent last, so `undo` and
   * `redo` never disagree about which one comes back next.
   */
  past: Shelf[]
  /** Shelves an `undo` stepped back out of, cleared by the next edit. */
  future: Shelf[]

  /**
   * Reads both stores, then folds in whatever the account holds. Does nothing on
   * a page that has already been opened.
   */
  load: () => Promise<void>
  /**
   * Reads the shelf off the account and folds it into this one.
   *
   * The account's copy is the shelf and this browser's is a cache of it, so this
   * takes rows away as well as bringing them in — a word deleted on a laptop is
   * meant to stay deleted here. What it will not drop is work made on this
   * machine since the last successful write; see `mergeRemoteShelf`.
   *
   * An account with no shelf yet is the migration: the folders in Drive are read
   * once, and what comes out of them is written up.
   */
  syncShelf: () => Promise<void>
  /**
   * The Drive folder for a word, made — along with the language and tier folders
   * above it — if it is not there yet. Null when Drive is not connected, which
   * is the signal to carry on locally.
   */
  ensureWordFolder: (wordId: string) => Promise<string | null>

  /** Steps the shelf back to what it was before the last edit, if there was one. */
  undo: () => void
  /** Steps it forward again to the edit an `undo` backed out of. */
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  /** Adds a tier, or selects the one already under that name. */
  addTier: (name: string) => void
  selectTier: (id: string | null) => void
  /** Deletes a tier and everything filed under it. */
  removeTier: (id: string) => Promise<void>

  /** Adds a language to the selected tier, or selects the one already there. */
  addLanguage: (name: string) => void
  selectLanguage: (id: string | null) => void
  /** Deletes a language, its words, and any video bytes left with nothing to reach them. */
  removeLanguage: (id: string) => Promise<void>

  /** Adds a word to the selected language, or selects the one already there. */
  addWord: (text: string) => void
  selectWord: (id: string | null) => void
  removeWord: (id: string) => Promise<void>

  /**
   * Renames a tier, a language or a word — here and in Drive, where it renames
   * the folder rather than making a new one.
   *
   * Refused when a sibling already has that name, which is the same rule adding
   * one follows: two folders of the same name under one parent are a shelf that
   * has quietly forked, and the column would show the pair with nothing to tell
   * them apart. False says the rename did not happen.
   */
  renameTier: (id: string, name: string) => boolean
  renameLanguage: (id: string, name: string) => boolean
  renameWord: (id: string, text: string) => boolean
  /**
   * Renames one take's file, in the catalogue and in Drive.
   *
   * No such rule here: a word's folder may hold two takes of the same name
   * without either becoming ambiguous, because everything that refers to them —
   * the sidecar, the run, the catalogue — goes by id.
   */
  renameVideo: (assetId: string, name: string) => void

  /** Puts an uploaded video on the end of a word's run, labelled as the word itself. */
  addVideo: (wordId: string, assetId: string) => void
  /**
   * Files videos from this machine — picked with the button or dragged in off
   * the desktop — into a word, and into that word's folder in Drive.
   *
   * One file at a time and in the order they were handed over: picking six
   * takes and having them land in whatever order six parallel ingests happened
   * to finish would mean re-ordering the run by hand every time, which is the
   * work this page exists to make easy.
   *
   * A second batch while one is running is refused rather than queued, because
   * both doors in show the one `uploading` and two overlapping batches would
   * report each other's progress.
   */
  addLocalVideos: (wordId: string, files: readonly File[]) => Promise<void>
  /**
   * Puts videos that are already in Drive on the end of a word's run.
   *
   * For the files this app cannot see by itself: `drive.file` grants it what it
   * created and what the user hands it through the Picker, and nothing else — so
   * a take dropped into the word's folder from a phone is in the folder, in the
   * user's Drive, and invisible to the read of the shelf until it is picked.
   * This is what picking it does.
   *
   * Each one is moved into the word's folder if it is not there already. Not
   * because anything would break otherwise — the run is the account's now, and a
   * take plays from wherever in Drive it sits — but because the folder tree is
   * the half of this shelf a person can open on their phone, and a word whose
   * folder does not hold its takes has stopped being legible in the way the
   * whole layout exists to be. The names it could not add come back, so the page
   * can say which and why.
   */
  addDriveVideos: (wordId: string, files: readonly DriveFile[]) => Promise<string[]>
  /**
   * Labels one take, or takes its label off — `undefined` is a label somebody
   * chose to remove, not a missing argument. Only the takes between the ends of
   * a run have anything to say here; see `roleInRun`.
   */
  setVideoRole: (wordId: string, videoId: string, role: WordVideoRole | undefined) => void
  setTranscript: (wordId: string, videoId: string, transcript: string) => void
  moveVideo: (wordId: string, from: number, to: number) => void
  removeVideo: (wordId: string, videoId: string) => Promise<void>

  selectedWord: () => Word | undefined
}

/*
 * Writing one row down, in two flavours.
 *
 * `persist*` is what an edit calls: store it here, and say the shelf has moved
 * so it goes up to the account a beat later. `store*` is the same write without
 * that second half, and exists for one caller — settling a shelf that has just
 * been *read* off the account. Marking those dirty would send back what we were
 * just told, which is a wasted round trip at best and two machines writing at
 * each other at worst.
 */
function storeWord(word: Word): void {
  void putWord(word).catch(() => {
    // Best-effort, like the project store: losing the write must not lose the
    // edit that is already on screen.
  })
}

function storeLanguage(language: Language): void {
  void putLanguage(language).catch(() => {})
}

function storeTier(tier: Tier): void {
  void putTier(tier).catch(() => {})
}

function persistWord(word: Word): void {
  storeWord(word)
  markShelfDirty()
}

function persistLanguage(language: Language): void {
  storeLanguage(language)
  markShelfDirty()
}

function persistTier(tier: Tier): void {
  storeTier(tier)
  markShelfDirty()
}

/**
 * Deletes the bytes behind videos nothing lists any more.
 *
 * Called after the words have already changed, and judged against the words as
 * they are then — deleting a word that shared a take with another word leaves
 * the take alone, because the other word still plays it. This is the local cache
 * only; the file in Drive is trashed separately, by whoever asked for the delete.
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

/** What a read of Drive has just taken away, so the local rows can go too. */
function gone<T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] {
  const kept = new Set(after.map((entry) => entry.id))
  return before.filter((entry) => !kept.has(entry.id))
}

/**
 * Whether a merge moved anything at all.
 *
 * Asked of the settled lists, which keep the object that was already there for
 * every row nothing happened to (see `settle`) — so this is object identity
 * rather than a comparison, and a shelf that came back exactly as it went in
 * answers no.
 */
function changed(before: Shelf, after: Shelf): boolean {
  const same = <T>(next: readonly T[], previous: readonly T[]) =>
    next.length === previous.length && next.every((entry, index) => entry === previous[index])

  return !(
    same(after.tiers, before.tiers) &&
    same(after.languages, before.languages) &&
    same(after.words, before.words)
  )
}

/**
 * The folder the shelf is kept in, or null when Drive is not in play.
 *
 * Every Drive call below starts here, which is what makes "works without Google"
 * one check rather than a scattering of them: no connection, no folder ids, and
 * the page is the local one it was before.
 */
function driveRoot(): string | null {
  const { status, folder } = useDriveStore.getState()
  return status === 'connected' && folder ? folder.id : null
}

/** Which Drive file backs a take. The one name this browser and Drive share. */
function driveFileIdOf(assetId: string): string | undefined {
  return useAssetStore.getState().byId(assetId)?.driveFileId
}

/**
 * Folder requests in flight, so two of them never make two folders.
 *
 * Real: uploading three takes at once asks for the same word folder three times
 * within a few milliseconds, and `findOrCreateFolder` cannot see a folder that
 * another call has not finished creating.
 */
const folderRequests = new Map<string, Promise<string | null>>()

function onceOnly(key: string, run: () => Promise<string | null>): Promise<string | null> {
  const existing = folderRequests.get(key)
  if (existing) return existing

  const request = run()
    .catch((cause: unknown) => {
      // Reported rather than thrown: a folder that could not be made means the
      // backup lands in the chosen folder instead of this word's, which is worth
      // saying and not worth failing an upload over.
      useWordsStore.setState({ syncError: toDisplayMessage(cause) })
      return null
    })
    .finally(() => folderRequests.delete(key))

  folderRequests.set(key, request)
  return request
}

/** The Drive folder for a tier, made under the chosen folder if it is not there. */
function ensureTierFolder(tierId: string): Promise<string | null> {
  const tier = useWordsStore.getState().tiers.find((entry) => entry.id === tierId)
  if (!tier) return Promise.resolve(null)
  if (tier.driveFolderId) return Promise.resolve(tier.driveFolderId)

  const root = driveRoot()
  if (!root) return Promise.resolve(null)

  return onceOnly(`tier:${tierId}`, async () => {
    const folderId = await findOrCreateFolder(tier.name, root)
    useWordsStore.setState((state) => ({
      tiers: state.tiers.map((entry) => {
        if (entry.id !== tierId) return entry
        const next = { ...entry, driveFolderId: folderId }
        persistTier(next)
        return next
      }),
    }))
    return folderId
  })
}

/** The Drive folder for a language, made inside its tier's folder. */
async function ensureLanguageFolder(languageId: string): Promise<string | null> {
  const language = useWordsStore.getState().languages.find((entry) => entry.id === languageId)
  if (!language) return null
  if (language.driveFolderId) return language.driveFolderId

  const parent = await ensureTierFolder(language.tierId)
  if (!parent) return null

  return await onceOnly(`language:${languageId}`, async () => {
    const folderId = await findOrCreateFolder(language.name, parent)
    useWordsStore.setState((state) => ({
      languages: state.languages.map((entry) => {
        if (entry.id !== languageId) return entry
        const next = { ...entry, driveFolderId: folderId }
        persistLanguage(next)
        return next
      }),
    }))
    return folderId
  })
}

/** Whether there is an account to keep the shelf on. */
function canSync(): boolean {
  return isSupabaseConfigured() && isSignedIn()
}

/**
 * The version of the shelf row this session last saw, and when it last agreed
 * with the account.
 *
 * The version is what makes a write safe: it goes up with every save, and a save
 * that finds it moved is a save somebody else got in front of. Null means this
 * session has not read the row yet, which is the same as saying the next write
 * is an insert.
 *
 * `syncedAt` is per browser rather than per session, because what it answers is
 * "which of the things on this machine has the account never been told about" —
 * a question a tab that has just opened has to be able to answer about work the
 * last one did offline. See `mergeRemoteShelf`.
 */
let shelfVersion: number | null = null

const SYNCED_AT_KEY = 'editor-cat.words.syncedAt.v1'

function syncedAt(): number {
  try {
    return Number(localStorage.getItem(SYNCED_AT_KEY)) || 0
  } catch {
    // Storage can be blocked outright. Zero is the safe answer: it treats
    // everything local as fresh, which keeps work rather than dropping it.
    return 0
  }
}

function rememberSyncedAt(when: number): void {
  try {
    localStorage.setItem(SYNCED_AT_KEY, String(when))
  } catch {
    // Same as above, and with the same consequence: nothing worse than a merge
    // that keeps too much.
  }
}

/**
 * Which tier, language and word the three columns were last pointing at.
 *
 * In localStorage rather than on the account, and deliberately: the shelf is
 * one person's across all their machines, but "the word I am watching" is about
 * this browser and this desk, and a laptop should not drag a phone off the word
 * it has open. Reloading the page is how somebody comes back to a take they
 * have just filmed into Drive, and landing at the top of all three columns
 * means finding the word again every time.
 */
const SELECTION_KEY = 'editor-cat.words.selection.v1'

const NOTHING_SELECTED: Selection = {
  selectedTierId: null,
  selectedLanguageId: null,
  selectedWordId: null,
}

function storedId(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function rememberedSelection(): Selection {
  try {
    const raw = localStorage.getItem(SELECTION_KEY)
    if (!raw) return NOTHING_SELECTED
    const parsed = JSON.parse(raw) as Partial<Record<keyof Selection, unknown>>
    return {
      selectedTierId: storedId(parsed.selectedTierId),
      selectedLanguageId: storedId(parsed.selectedLanguageId),
      selectedWordId: storedId(parsed.selectedWordId),
    }
  } catch {
    // Storage blocked, or something under the key that is not a selection.
    // Either way the page opens on the first of each column, which is where it
    // opened before any of this was remembered.
    return NOTHING_SELECTED
  }
}

function rememberSelection({
  selectedTierId,
  selectedLanguageId,
  selectedWordId,
}: Selection): void {
  try {
    // Picked apart rather than written whole: the caller hands over the store,
    // and the three lists have no business in localStorage.
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ selectedTierId, selectedLanguageId, selectedWordId }),
    )
  } catch {
    // Same as above: what is lost is the next reload landing where this one is.
  }
}

/**
 * How long after the last edit the shelf is written up.
 *
 * Long enough that dragging a run into order is one write rather than five, and
 * short enough that closing the tab a moment later has already saved it.
 */
const SHELF_DELAY = 1200

const shelfWrites = createScheduler(async () => {
  await pushShelf()
}, SHELF_DELAY)

/**
 * Says the shelf has changed and should be written up.
 *
 * Called by every edit rather than by the store's persistence helpers, so that
 * the writes a *read* makes — settling merged rows back into IndexedDB — do not
 * bounce straight back to the server as a change.
 */
function markShelfDirty(): void {
  if (!canSync()) return
  shelfWrites.schedule()
}

/** The three lists as they are right now, which is what gets written. */
function lists(): Shelf {
  const { tiers, languages, words } = useWordsStore.getState()
  return { tiers, languages, words }
}

/**
 * Writes the shelf to the account, re-reading once if somebody moved ahead.
 *
 * The retry is not optimism: this is one document per person, so a conflict is
 * another tab or another machine of theirs, and the answer is always to take
 * what is up there, fold this machine's work into it and write again — never to
 * ask the user to reload, which is what a project conflict does.
 */
async function pushShelf(): Promise<void> {
  if (!canSync()) return

  try {
    // Stamped before the write rather than after it: a word added while the
    // request was in flight is not in the document being sent, and a stamp taken
    // on the way back would call it sent. The next read would then treat it as
    // deleted somewhere else.
    const at = Date.now()
    const landed = await putShelf(buildShelfDoc(lists()), shelfVersion)
    if (landed !== null) {
      shelfVersion = landed
      rememberSyncedAt(at)
      return
    }

    const stored = await getShelf()
    if (!stored) return
    shelfVersion = stored.version
    applyRemote(parseShelfDoc(stored.doc))

    const retriedAt = Date.now()
    const second = await putShelf(buildShelfDoc(lists()), shelfVersion)
    if (second === null) return
    shelfVersion = second
    rememberSyncedAt(retriedAt)
  } catch (cause) {
    // Best-effort, like every other write here: what is lost is the edit
    // reaching the other machine, not the edit on this one. It goes up with the
    // next change, and the message says why in the meantime.
    useWordsStore.setState({ syncError: toDisplayMessage(cause) })
  }
}

/**
 * Folds the account's shelf into this browser's, and writes the result down.
 *
 * The stored copy is the one that is settled against, so nothing is written back
 * to IndexedDB or re-rendered for having been read — see `settle`. What the read
 * took away is deleted locally too, bytes and all: a word deleted on a laptop
 * otherwise leaves a row here and a file nothing on this machine can reach.
 */
function applyRemote(remote: Shelf): void {
  const before = lists()
  const merged = mergeRemoteShelf(remote, before, syncedAt())

  const tiers = settle(merged.tiers, before.tiers, storeTier)
  const languages = settle(merged.languages, before.languages, storeLanguage)
  const words = settle(merged.words, before.words, storeWord)

  useWordsStore.setState((state) => ({
    tiers,
    languages,
    words,
    ...settledSelection(state, { tiers, languages, words }),
    // An undo writes the shelf it restores back up to the account, so a stack
    // taken from before a read is a stack that would send a word another machine
    // has just added — or just deleted — the other way. Anything the account had
    // a say in ends what there is to take back here.
    ...(changed(before, { tiers, languages, words }) ? { past: [], future: [] } : {}),
  }))

  void Promise.all([
    forgetOrphanedAssets(assetIdsOf(before.words), words),
    ...gone(before.words, words).map((word) => dbDeleteWord(word.id).catch(() => {})),
    ...gone(before.languages, languages).map((entry) => dbDeleteLanguage(entry.id).catch(() => {})),
    ...gone(before.tiers, tiers).map((entry) => dbDeleteTier(entry.id).catch(() => {})),
  ])
}

/**
 * Builds a shelf out of the folders in Drive, for an account that has no shelf
 * and a browser that has no copy of one.
 *
 * The migration, and the only thing that reads the folder tree now. Anybody who
 * used the word pages before the shelf moved to the account has their tiers,
 * languages, words and the order of every run in Drive and nowhere else — in the
 * folders, and in the `editor-cat.json` beside each word's videos. This reads
 * that once, and what it produces is written up like any other change.
 *
 * A failure here is reported and not thrown: an account with no shelf and a
 * browser with one still has a shelf to save, and that must not be held up by
 * Drive being slow or disconnected.
 */
async function importFromDrive(): Promise<void> {
  const root = driveRoot()
  if (!root) return

  try {
    const before = lists()
    const discovered = await adoptDiscovered(await readShelf(root))
    const merged = mergeShelf(before, discovered, driveFileIdOf)

    useWordsStore.setState((state) => {
      const tiers = settle(merged.tiers, before.tiers, storeTier)
      const languages = settle(merged.languages, before.languages, storeLanguage)
      const words = settle(merged.words, before.words, storeWord)
      return { tiers, languages, words, ...settledSelection(state, { tiers, languages, words }) }
    })
  } catch (cause) {
    useWordsStore.setState({ syncError: toDisplayMessage(cause) })
  }
}

/**
 * Gives every take a catalogue entry, wherever the entry has to come from — and
 * makes sure the account could give one to the next machine that asks.
 *
 * The shelf names its videos by asset id and by nothing else, so an id that
 * resolves to nothing is a row saying the file is not on this machine and a take
 * the player will not draw at all — for a file sitting in the word's own Drive
 * folder. Three places can answer, in this order:
 *
 *  - the catalogue, when it has already been read;
 *  - this browser's own store, which the catalogue is a read of and which can
 *    still be loading when the account answers first (see Root.tsx). "Not in the
 *    catalogue" is not "not on this machine", and treating it as such would file
 *    a second entry over the first — with a fresh blob key, and so with none of
 *    the bytes the old key still names;
 *  - the account's asset rows, which are how a machine that has never held the
 *    file learns what it is and which Drive file holds it. The same trick
 *    `hydrateProject` does for a timeline, at the scale of a shelf.
 *
 * And it answers back. A take this browser holds that the account has never
 * heard of is written up, because plenty are: nothing recorded a row for a take
 * catalogued out of the folder tree until the shelf moved to the account, so a
 * shelf built from those names ids no other machine can resolve — which is a
 * second machine seeing a word's whole run as files it has not got, with no way
 * to ever fetch them.
 */
async function hydrateShelfAssets(words: readonly Word[]): Promise<void> {
  const ids = [...new Set(assetIdsOf(words))]
  if (ids.length === 0) return

  const rows = new Map((await getAssets(ids)).map((row) => [row.id, row] as const))

  for (const id of ids) {
    // Read afresh each time round rather than snapshotted: the catalogue's own
    // load can land in the middle of this, and so can the line below.
    const held = useAssetStore.getState().byId(id) ?? (await getAsset(id))
    if (held) {
      if (!rows.has(id)) void recordAsset(held)
      if (!useAssetStore.getState().byId(id)) useAssetStore.getState().adopt(held)
      continue
    }

    const row = rows.get(id)
    if (!row) continue
    // A blob key names an IndexedDB entry on one machine and nothing anywhere
    // else, so it is made here rather than carried.
    const asset = fromRow(row, newId('blob'))
    await putAsset(asset)
    useAssetStore.getState().adopt(asset)
  }
}

/**
 * A catalogue entry for a video that is in Drive and not on this machine.
 *
 * Names only: the bytes follow when the word is opened (see
 * hooks/useWordVideoBytes.ts), and `blobKey` is where they will land. Both ways
 * a Drive video reaches a word — found by a read of the shelf, or handed over
 * through the Picker — come through here, so a file is catalogued the same way
 * whichever door it came in by.
 */
async function catalogueVideo(file: {
  id: string
  name: string
  mimeType: string
}): Promise<Asset> {
  const asset = {
    id: newId('asset'),
    kind: 'video',
    blobKey: newId('blob'),
    mimeType: file.mimeType,
    name: file.name,
    driveFileId: file.id,
    createdAt: Date.now(),
  } satisfies Asset

  await putAsset(asset)
  useAssetStore.getState().adopt(asset)
  // Recorded against the account as well, the way `ingestBlob` does for an
  // upload (see Root.tsx): the shelf names its takes by asset id, so a machine
  // that has never seen this file needs a row to resolve that id against.
  void recordAsset(asset)
  return asset
}

/** The catalogue entry for a Drive file, if this browser already has one. */
function assetForDriveFile(driveFileId: string): Asset | undefined {
  return useAssetStore.getState().assets.find((asset) => asset.driveFileId === driveFileId)
}

/**
 * Gives every video file found in Drive a catalogue entry, so the shelf can name
 * it before any of its bytes are here.
 *
 * Metadata first and bytes second, exactly as hydration does for a project: the
 * page draws the whole run immediately, and the takes fill in as they come down
 * (see hooks/useWordVideoBytes.ts). A file this browser already knows is matched
 * by its Drive id rather than fetched a second time.
 */
async function adoptDiscovered(tiers: readonly RawTier[]): Promise<DiscoveredTier[]> {
  const byDriveId = new Map(
    useAssetStore
      .getState()
      .assets.flatMap((asset) => (asset.driveFileId ? [[asset.driveFileId, asset] as const] : [])),
  )

  const discovered: DiscoveredTier[] = []
  for (const tier of tiers) {
    const languages = []
    for (const language of tier.languages) {
      const words = []
      for (const word of language.words) {
        const videos = []
        for (const file of word.files) {
          let asset = byDriveId.get(file.id)
          if (asset) {
            // Recorded against the account even though this browser already had
            // it, because the shelf about to be built out of these names it by
            // asset id: a file catalogued here before there were rows to record
            // is one no other machine could ever resolve.
            void recordAsset(asset)
          } else {
            asset = await catalogueVideo(file)
            byDriveId.set(file.id, asset)
          }
          videos.push({ driveFileId: file.id, assetId: asset.id })
        }
        words.push({ folderId: word.folderId, name: word.name, videos, sidecar: word.sidecar })
      }
      languages.push({ folderId: language.folderId, name: language.name, words })
    }
    discovered.push({ folderId: tier.folderId, name: tier.name, languages })
  }
  return discovered
}

/**
 * Keeps the object that was already there when a merge changed nothing about it.
 *
 * Two jobs at once, both of which matter every time the page is opened: nothing
 * is written back to IndexedDB for having been read, and nothing on screen
 * re-renders — so a sync landing while somebody is typing in a transcript box
 * leaves that box alone.
 */
function settle<T extends { id: string }>(
  next: readonly T[],
  previous: readonly T[],
  persist: (entry: T) => void,
): T[] {
  const before = new Map(previous.map((entry) => [entry.id, entry] as const))
  return next.map((entry) => {
    const old = before.get(entry.id)
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return old
    persist(entry)
    return entry
  })
}

/*
 * ---------------------------------------------------------------------------
 * Taking an edit back.
 *
 * A step is the whole shelf, the way a step in the editor is the whole project:
 * the three lists are one document, and a step that is a picture of them cannot
 * disagree with itself about what a delete took along with it.
 *
 * What makes this more than a list of snapshots is that a delete here reaches
 * past this browser — bytes cleared, a folder in the Drive bin — so putting one
 * back has to reach the same way. See `restoreShelf`.
 * ---------------------------------------------------------------------------
 */

/** How many edits back `undo` can reach before the oldest ones fall off. */
const MAX_HISTORY = 100

/**
 * What the step on top of the stack was for, when steps of that kind should not
 * pile up.
 *
 * Typing a transcript is one thing somebody did and forty calls to
 * `setTranscript`, so a step carrying the key of the one before it is folded
 * into it and an undo takes the sentence back rather than the last letter. Any
 * other edit — or an undo — clears it, because carrying on typing after either
 * is a new thing to be able to take back.
 */
let lastStepKey: string | null = null

/**
 * Puts the shelf as it stands on the stack, in front of the edit about to change
 * it.
 *
 * Called by each edit itself rather than by the persistence helpers, and always
 * after whatever check would refuse it: a rename to a name a sibling already
 * has, or an add that only selects what was there, are not steps to walk back
 * through. The reads — a load, a sync, a folder id landing — deliberately do not
 * come through here at all.
 */
function recordStep(key?: string): void {
  if (key && key === lastStepKey) return
  lastStepKey = key ?? null
  useWordsStore.setState((state) => ({
    past: [...state.past, lists()].slice(-MAX_HISTORY),
    future: [],
  }))
}

/**
 * Carries across a step what the stack does not own: which folder in Drive a row
 * is.
 *
 * A folder is made a beat after the row that wanted it (see `ensureTierFolder`),
 * so a step taken inside that beat is a picture of a row that did not know its
 * folder yet — and restoring it verbatim would forget a folder that exists,
 * leaving the next rename and the next delete pointing at nothing and the next
 * upload filed somewhere else. Nothing on the stack ever changes a folder id, so
 * the one this browser knows now is always the right one.
 */
function withKnownFolders<T extends { id: string; driveFolderId?: string }>(
  restored: readonly T[],
  current: readonly T[],
): T[] {
  const folders = new Map(
    current.flatMap((entry) =>
      entry.driveFolderId ? [[entry.id, entry.driveFolderId] as const] : [],
    ),
  )
  return restored.map((entry) => {
    const folderId = folders.get(entry.id)
    return !entry.driveFolderId && folderId ? { ...entry, driveFolderId: folderId } : entry
  })
}

/**
 * Puts a shelf from the stack back — on screen, in storage, on the account and
 * in Drive.
 *
 * The settling is the same one a read from the account does, and for the same
 * two reasons: rows that came back are written down and rows that went away are
 * deleted, while anything the step did not touch keeps the object it already
 * had, so nothing on screen re-renders for a step it was not in.
 *
 * What this deliberately does not do is take bytes away. A redo may want the
 * take an undone add pointed at, and another word may be playing it either way;
 * bytes nothing lists any more are what Settings clears.
 */
function restoreShelf(next: Shelf): void {
  const before = lists()

  const tiers = settle(withKnownFolders(next.tiers, before.tiers), before.tiers, storeTier)
  const languages = settle(
    withKnownFolders(next.languages, before.languages),
    before.languages,
    storeLanguage,
  )
  const words = settle(withKnownFolders(next.words, before.words), before.words, storeWord)

  useWordsStore.setState((state) => ({
    tiers,
    languages,
    words,
    ...settledSelection(state, { tiers, languages, words }),
  }))

  // The shelf this restores is the shelf now, and the account is holding the one
  // the step moved off.
  markShelfDirty()

  void Promise.all([
    ...gone(before.words, words).map((word) => dbDeleteWord(word.id).catch(() => {})),
    ...gone(before.languages, languages).map((entry) => dbDeleteLanguage(entry.id).catch(() => {})),
    ...gone(before.tiers, tiers).map((entry) => dbDeleteTier(entry.id).catch(() => {})),
  ])

  // Both halves of what a delete took away outside the shelf, in this order: the
  // catalogue rows come back first, and the files in Drive are asked for by the
  // Drive ids those rows are the only place to read.
  void (async () => {
    if (canSync()) await hydrateShelfAssets(words).catch(() => {})
    await untrashRestored(before, { tiers, languages, words })
  })()
}

/** What a step has brought back: in the shelf being restored and not in the one being left. */
function returned<T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] {
  return gone(after, before)
}

/**
 * Takes back out of the Drive bin whatever a step has just put back on the
 * shelf.
 *
 * Deleting on this page really does delete over there (see `trashInDrive`), so
 * an undo that stopped at this browser would restore a word whose folder is in
 * the bin: rows on screen, nothing to play, and a second machine that reads the
 * shelf and finds the files gone.
 *
 * Only the topmost thing that came back is asked for, because trashing a folder
 * took what was inside it along and untrashing it brings the same back. And
 * whatever trashing is still in flight is waited for first — an undo pressed a
 * moment after a delete would otherwise take a file out of the bin before the
 * delete had finished putting it in.
 */
async function untrashRestored(before: Shelf, after: Shelf): Promise<void> {
  if (!driveRoot()) return
  await binWork

  const tiers = returned(before.tiers, after.tiers)
  const languages = returned(before.languages, after.languages)
  const words = returned(before.words, after.words)

  const backTiers = new Set(tiers.map((tier) => tier.id))
  const backLanguages = new Set(languages.map((language) => language.id))
  const backWords = new Set(words.map((word) => word.id))

  await Promise.all([
    ...tiers.map((tier) => untrashInDrive(tier.driveFolderId)),
    ...languages
      .filter((language) => !backTiers.has(language.tierId))
      .map((language) => untrashInDrive(language.driveFolderId)),
    ...words
      .filter((word) => !backLanguages.has(word.languageId))
      .map((word) => untrashInDrive(word.driveFolderId)),
    // The takes that came back on their own, into a word that never went away.
    // Anything inside a folder above came back when that folder did.
    ...after.words
      .filter((word) => !backWords.has(word.id))
      .flatMap((word) => {
        const kept = before.words.find((entry) => entry.id === word.id)
        if (!kept) return []
        const had = new Set(kept.videos.map((video) => video.id))
        return word.videos
          .filter((video) => !had.has(video.id))
          .map((video) => untrashInDrive(driveFileIdOf(video.assetId)))
      }),
  ])
}

/**
 * Puts a take on the end of a word's run without touching the stack, for the two
 * callers that own their step themselves.
 */
function appendVideo(wordId: string, assetId: string): void {
  useWordsStore.setState((state) => ({
    words: mapWord(state.words, wordId, (word) => withVideo(word, newWordVideo(assetId))),
  }))
}

export const useWordsStore = create<WordsState>((set, get) => ({
  tiers: [],
  languages: [],
  words: [],
  selectedTierId: null,
  selectedLanguageId: null,
  selectedWordId: null,
  loading: true,
  loaded: false,
  syncing: false,
  syncError: null,
  uploading: null,
  uploadError: null,
  past: [],
  future: [],

  load: async () => {
    // Leaving the page and coming back to it should come back to what was open,
    // and re-reading would put the selection back to the top of all three columns.
    if (get().loaded) return
    set({ loading: true })
    try {
      const [tiers, stored, words] = await Promise.all([listTiers(), listLanguages(), listWords()])
      // A language saved before the shelf grew a tier above it has nowhere to
      // hang: its folder is at the root, which is where tiers live now. Left out
      // rather than guessed at — nothing in Drive is touched, so moving that
      // folder under a tier folder is all it takes to have it read back in.
      const languages = stored.filter((language) => language.tierId)
      set({
        tiers,
        languages,
        words,
        loading: false,
        loaded: true,
        // What was read is where the page starts, so there is nothing behind it
        // to step back to — and anything added while the read was in flight is
        // about to be replaced by it.
        past: [],
        future: [],
        // Back to the word this browser had open, and to the first of each
        // column when it has none or what it had is gone — so a page that has
        // been used before opens on something rather than on three empty
        // columns and a prompt.
        ...reopeningSelection({ tiers, languages, words }),
      })
    } catch {
      // Nothing to show and nothing to be done about it from here. Not latched
      // as loaded: coming back to the page is a fair second try.
      set({ tiers: [], languages: [], words: [], loading: false })
    }

    // The local copy is on screen by now, and the account is what says whether
    // it is the whole shelf. Not awaited by the caller for exactly that reason:
    // a machine that already has the words should draw them, not spin.
    void get().syncShelf()
  },

  syncShelf: async () => {
    if (!canSync() || get().syncing) return

    set({ syncing: true, syncError: null })
    try {
      // Before the read, for the same reason the write stamps before it goes:
      // whatever is made while this is in flight has not been sent.
      const at = Date.now()
      const stored = await getShelf()

      if (!stored) {
        // Nothing on the account yet. Either this machine is the one holding the
        // shelf — the common case, everybody who used the page before it moved
        // — or it has nothing and the folders in Drive are all there is to go on.
        if (get().words.length === 0 && get().tiers.length === 0) await importFromDrive()
        shelfVersion = null
        set({ syncing: false })
        // Written up rather than left: an account with no shelf and a browser
        // with one is the migration, and it happens by saving.
        markShelfDirty()
        return
      }

      shelfVersion = stored.version
      applyRemote(parseShelfDoc(stored.doc))
      await hydrateShelfAssets(get().words)
      rememberSyncedAt(at)
      set({ syncing: false })
    } catch (cause) {
      // The shelf on screen is still the shelf; what failed is finding out
      // whether it is missing anything.
      set({ syncing: false, syncError: toDisplayMessage(cause) })
    }
  },

  ensureWordFolder: async (wordId) => {
    const word = get().words.find((entry) => entry.id === wordId)
    if (!word) return null
    if (word.driveFolderId) return word.driveFolderId

    const parent = await ensureLanguageFolder(word.languageId)
    if (!parent) return null

    return await onceOnly(`word:${wordId}`, async () => {
      const folderId = await findOrCreateFolder(word.text, parent)
      set((state) => ({
        words: state.words.map((entry) => {
          if (entry.id !== wordId) return entry
          const next = { ...entry, driveFolderId: folderId }
          persistWord(next)
          return next
        }),
      }))
      return folderId
    })
  },

  undo: () => {
    const { past, future } = get()
    const previous = past.at(-1)
    if (!previous) return

    set({ past: past.slice(0, -1), future: [lists(), ...future] })
    restoreShelf(previous)
    // Typing into a transcript after an undo is a new step, not more of the one
    // that was just taken back.
    lastStepKey = null
  },

  redo: () => {
    const { past, future } = get()
    const [next] = future
    if (!next) return

    set({ past: [...past, lists()], future: future.slice(1) })
    restoreShelf(next)
    lastStepKey = null
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  addTier: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return

    const existing = findTier(get().tiers, trimmed)
    if (existing) {
      get().selectTier(existing.id)
      return
    }

    recordStep()
    const tier = newTier(trimmed)
    persistTier(tier)
    set((state) => ({
      tiers: [...state.tiers, tier],
      selectedTierId: tier.id,
      // Nothing in it yet, so nothing below it to be looking at.
      selectedLanguageId: null,
      selectedWordId: null,
    }))

    // Its folder, made now rather than when the first video arrives: adding a
    // tier is what it means to want one, and a folder waiting in Drive is where
    // somebody would file things from a phone.
    void ensureTierFolder(tier.id)
  },

  selectTier: (id) => {
    set((state) => ({
      selectedTierId: id,
      // The two columns to the right are about whatever this one has open, so
      // moving it resettles both rather than leaving a language from another
      // tier on screen.
      ...belowTier(state, id),
    }))
  },

  removeTier: async (id) => {
    const doomed = get().tiers.find((tier) => tier.id === id)
    if (!doomed) return

    recordStep()
    const doomedLanguages = get().languages.filter((language) => language.tierId === id)
    const doomedIds = new Set(doomedLanguages.map((language) => language.id))
    const doomedWords = get().words.filter((word) => doomedIds.has(word.languageId))
    const assetIds = assetIdsOf(doomedWords)
    const folderId = doomed.driveFolderId

    const tiers = get().tiers.filter((tier) => tier.id !== id)
    const languages = get().languages.filter((language) => language.tierId !== id)
    const words = get().words.filter((word) => !doomedIds.has(word.languageId))
    set((state) => ({
      tiers,
      languages,
      words,
      ...(state.selectedTierId === id ? openingSelection({ tiers, languages, words }) : {}),
    }))

    // Deletes do not go through `persistTier` and friends, so they say so here.
    markShelfDirty()
    await Promise.all([
      dbDeleteTier(id),
      ...doomedLanguages.map((language) => dbDeleteLanguage(language.id)),
      ...doomedWords.map((word) => dbDeleteWord(word.id)),
    ]).catch(() => {})
    // One call takes the languages, their words and their videos with it,
    // because trashing a folder trashes everything inside it.
    await trashInDrive(folderId)
    await forgetOrphanedAssets(assetIds, words)
  },

  addLanguage: (name) => {
    const tierId = get().selectedTierId
    const trimmed = name.trim()
    if (!tierId || !trimmed) return

    const existing = findLanguage(get().languages, tierId, trimmed)
    if (existing) {
      get().selectLanguage(existing.id)
      return
    }

    recordStep()
    const language = newLanguage(tierId, trimmed)
    persistLanguage(language)
    set((state) => ({
      languages: [...state.languages, language],
      selectedLanguageId: language.id,
      // Nothing in it yet, so nothing to be looking at.
      selectedWordId: null,
    }))

    void ensureLanguageFolder(language.id)
  },

  selectLanguage: (id) => {
    set((state) => ({
      selectedLanguageId: id,
      // A language and a word from another language is not a state the page can
      // draw, so switching the middle column always resettles the last one.
      selectedWordId: wordsInLanguage(state.words, id)[0]?.id ?? null,
    }))
  },

  /**
   * The screen changes first and storage catches up, which is the same order
   * every edit in this app is made in: nothing on screen should wait for a
   * write, and a write that fails costs the save rather than the action.
   */
  removeLanguage: async (id) => {
    const language = get().languages.find((entry) => entry.id === id)
    if (!language) return

    recordStep()
    const doomed = get().words.filter((word) => word.languageId === id)
    const assetIds = assetIdsOf(doomed)
    const folderId = language.driveFolderId

    const languages = get().languages.filter((language) => language.id !== id)
    const words = get().words.filter((word) => word.languageId !== id)
    set((state) => ({
      languages,
      words,
      ...(state.selectedLanguageId === id
        ? belowTier({ ...state, languages, words }, state.selectedTierId)
        : {}),
    }))

    markShelfDirty()
    await Promise.all([dbDeleteLanguage(id), ...doomed.map((word) => dbDeleteWord(word.id))]).catch(
      () => {},
    )
    // One call takes the words and their videos with it, because trashing a
    // folder trashes what is inside it.
    await trashInDrive(folderId)
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

    recordStep()
    const word = newWord(languageId, trimmed)
    persistWord(word)
    set((state) => ({ words: [...state.words, word], selectedWordId: word.id }))

    void get().ensureWordFolder(word.id)
  },

  selectWord: (id) => set({ selectedWordId: id }),

  removeWord: async (id) => {
    const doomed = get().words.find((word) => word.id === id)
    if (!doomed) return

    recordStep()
    const words = get().words.filter((word) => word.id !== id)
    set((state) => ({
      words,
      ...(state.selectedWordId === id
        ? { selectedWordId: wordsInLanguage(words, state.selectedLanguageId)[0]?.id ?? null }
        : {}),
    }))

    markShelfDirty()
    await dbDeleteWord(id).catch(() => {})
    await trashInDrive(doomed.driveFolderId)
    await forgetOrphanedAssets(assetIdsOf([doomed]), words)
  },

  renameTier: (id, name) => {
    const trimmed = name.trim()
    const tier = get().tiers.find((entry) => entry.id === id)
    if (!tier || !trimmed || sameName(tier.name, trimmed)) return false

    const clash = findTier(get().tiers, trimmed)
    if (clash && clash.id !== id) return false

    recordStep()
    set((state) => ({
      tiers: state.tiers.map((entry) => {
        if (entry.id !== id) return entry
        const next = { ...entry, name: trimmed }
        persistTier(next)
        return next
      }),
    }))
    void renameInDrive(tier.driveFolderId, trimmed)
    return true
  },

  renameLanguage: (id, name) => {
    const trimmed = name.trim()
    const language = get().languages.find((entry) => entry.id === id)
    if (!language || !trimmed || sameName(language.name, trimmed)) return false

    const clash = findLanguage(get().languages, language.tierId, trimmed)
    if (clash && clash.id !== id) return false

    recordStep()
    set((state) => ({
      languages: state.languages.map((entry) => {
        if (entry.id !== id) return entry
        const next = { ...entry, name: trimmed }
        persistLanguage(next)
        return next
      }),
    }))
    void renameInDrive(language.driveFolderId, trimmed)
    return true
  },

  renameWord: (id, text) => {
    const trimmed = text.trim()
    const word = get().words.find((entry) => entry.id === id)
    if (!word || !trimmed || sameName(word.text, trimmed)) return false

    const clash = findWord(get().words, word.languageId, trimmed)
    if (clash && clash.id !== id) return false

    recordStep()
    // Through `mapWord`, which also marks the sidecar for rewriting — the file
    // beside the videos names the word it is for, and a stale name in it would
    // be the one the next machine reads.
    set((state) => ({ words: mapWord(state.words, id, (entry) => ({ ...entry, text: trimmed })) }))
    void renameInDrive(word.driveFolderId, trimmed)
    return true
  },

  /*
   * Not a step, unlike everything above and below it: a take's name is the
   * file's, kept in the catalogue and in Drive, and none of it is on the shelf a
   * step is a picture of. An undo that appeared to take a rename back and left
   * the file called the new thing would be the worst of both.
   */
  renameVideo: (assetId, name) => {
    const trimmed = name.trim()
    const asset = useAssetStore.getState().byId(assetId)
    if (!asset || !trimmed || asset.name === trimmed) return

    void useAssetStore.getState().update(assetId, { name: trimmed })
    void renameInDrive(asset.driveFileId, trimmed)
  },

  addVideo: (wordId, assetId) => {
    recordStep()
    appendVideo(wordId, assetId)
  },

  addLocalVideos: async (wordId, files) => {
    const chosen = [...files]
    if (get().uploading || chosen.length === 0) return
    if (!get().words.some((entry) => entry.id === wordId)) return

    set({ uploading: { wordId, done: 0, total: chosen.length }, uploadError: null })
    try {
      // Asked for once, before the first byte is read: it is the same folder for
      // every file in this batch, and making it is what stops six uploads racing
      // to create six of it. Null when there is no Drive to make it in, which
      // sends the backup nowhere and the file nowhere but here.
      const driveParentId = (await get().ensureWordFolder(wordId)) ?? undefined

      for (const [done, file] of chosen.entries()) {
        set({ uploading: { wordId, done, total: chosen.length } })
        // Worth saying rather than skipping quietly: dropping a folder, or the
        // wrong file out of a folder of takes, is easy to do and leaves a run
        // that is simply one short.
        if (!file.type.startsWith('video/')) {
          set({ uploadError: `"${file.name}" is not a video.` })
          continue
        }
        const asset = await ingestBlob(file, { kind: 'video', name: file.name, driveParentId })
        // Into the catalogue but into no project's library: this belongs to a
        // word, not to whatever timeline happens to be open.
        useAssetStore.getState().adopt(asset)
        get().addVideo(wordId, asset.id)
      }
    } catch (cause) {
      set({ uploadError: toDisplayMessage(cause) })
    } finally {
      set({ uploading: null })
    }
  },

  addDriveVideos: async (wordId, files) => {
    if (!get().words.some((entry) => entry.id === wordId)) return []

    // Asked for once, before the first file: the folder is the same for all of
    // them, and this is where a word that has never been in Drive gets one.
    const folderId = await get().ensureWordFolder(wordId)
    const failed: string[] = []
    /**
     * One step for the whole pick, the way the editor makes "add all" one: six
     * takes chosen in one dialog are one thing somebody did, however many of
     * them turn out to be new. Recorded on the way to the first that is, so a
     * pick that adds nothing leaves nothing to walk back through.
     */
    let recorded = false

    for (const file of files) {
      try {
        const known = assetForDriveFile(file.id)
        // Picking a take the run already has is a no-op rather than a second
        // row: the Picker opens in the word's own folder, so the takes already
        // listed here are the ones most likely to be picked by mistake. Read
        // from the store each time, since the loop is adding to it.
        const run = get().words.find((entry) => entry.id === wordId)?.videos ?? []
        if (known && run.some((video) => video.assetId === known.id)) continue

        // Into the word's folder, so the tree still reads as the shelf it is
        // meant to be. See the note on this action.
        if (folderId) await moveFile(file.id, folderId)
        const asset = known ?? (await catalogueVideo(file))
        if (!recorded) {
          recordStep()
          recorded = true
        }
        appendVideo(wordId, asset.id)
      } catch (cause) {
        // One take that would not move leaves the rest of the pick alone. The
        // video is still in Drive and still theirs; what failed is filing it.
        failed.push(`${file.name}: ${toDisplayMessage(cause)}`)
      }
    }

    return failed
  },

  setVideoRole: (wordId, videoId, role) => {
    recordStep()
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { role })),
    }))
  },

  setTranscript: (wordId, videoId, transcript) => {
    // Keyed on the box being typed into, so a sentence is one step and moving to
    // another take starts another. See `lastStepKey`.
    recordStep(`transcript:${wordId}:${videoId}`)
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { transcript })),
    }))
  },

  moveVideo: (wordId, from, to) => {
    recordStep()
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withMovedVideo(word, from, to)),
    }))
  },

  removeVideo: async (wordId, videoId) => {
    const assetId = get()
      .words.find((word) => word.id === wordId)
      ?.videos.find((video) => video.id === videoId)?.assetId
    // Every take names an asset, so nothing found means nothing to remove — and
    // nothing for an undo to walk back through either.
    if (!assetId) return
    const driveFileId = driveFileIdOf(assetId)

    recordStep()
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withoutVideo(word, videoId)),
    }))

    // Only once nothing else lists it, and for the same reason the bytes go:
    // another word playing the same take still wants the file it plays.
    if (isVideoAssetOrphaned(assetId, get().words)) await trashInDrive(driveFileId)
    await forgetOrphanedAssets([assetId], get().words)
  },

  selectedWord: () => {
    const { words, selectedWordId } = get()
    return words.find((word) => word.id === selectedWordId)
  },
}))

/**
 * Keeps the remembered selection in step with the columns.
 *
 * One listener rather than a write inside `selectTier`, `selectLanguage` and
 * `selectWord`, because those three are not the only things that move the
 * selection: adding moves it, deleting resettles the columns below, and a sync
 * can take the open word away entirely. This catches all of them, and cannot be
 * forgotten by the next action that moves a column.
 */
useWordsStore.subscribe((state, previous) => {
  if (
    state.selectedTierId === previous.selectedTierId &&
    state.selectedLanguageId === previous.selectedLanguageId &&
    state.selectedWordId === previous.selectedWordId
  ) {
    return
  }
  rememberSelection(state)
})

/**
 * Renames a folder or a file over in Drive, if there is one and Drive is there
 * to take it.
 *
 * The id never changes, which is what makes this a rename rather than a move:
 * everything on both sides — the merge, the sidecar, the catalogue — points at
 * ids, so the new name is the only thing that travels.
 */
async function renameInDrive(fileId: string | undefined, name: string): Promise<void> {
  if (!fileId || !driveRoot()) return
  try {
    await renameFile(fileId, name)
  } catch (cause) {
    // The name on screen and in this browser has already changed, so what is
    // left is a folder in Drive still called the old thing. Worth saying;
    // nothing is lost, and renaming again retries it.
    useWordsStore.setState({ syncError: toDisplayMessage(cause) })
  }
}

/**
 * The trashing that has not landed yet.
 *
 * An undo takes back out of the bin what a delete put in it, and the two are a
 * second apart at most — so the untrash waits for this rather than racing it,
 * because a `trashed: true` that arrives after the `trashed: false` leaves the
 * file in the bin and the shelf saying it is not.
 */
let binWork: Promise<unknown> = Promise.resolve()

/**
 * Puts a folder or a file in the Drive bin, if there is one and Drive is there
 * to take it.
 *
 * Deleting here really does delete over there, which is a departure from the
 * rest of the app — the Library is emphatic that your Drive copy is left alone.
 * The difference is that this shelf *is* the folder tree: a take removed from a
 * word and left sitting in that word's folder would simply be found again on the
 * next read, and come back from the dead. Drive's own bin is what makes that
 * safe rather than final — and what an undo reaches into.
 */
async function trashInDrive(fileId: string | undefined): Promise<void> {
  if (!fileId || !driveRoot()) return
  const work = trashFile(fileId).catch((cause: unknown) => {
    // Worth saying, and not worth undoing the delete over: what is left is an
    // item in Drive that this shelf no longer lists, which the next read will
    // offer back rather than lose.
    useWordsStore.setState({ syncError: toDisplayMessage(cause) })
  })
  binWork = Promise.all([binWork, work])
  await work
}

/** Takes one back out again, for an undo. See `untrashRestored`. */
async function untrashInDrive(fileId: string | undefined): Promise<void> {
  if (!fileId || !driveRoot()) return
  try {
    await untrashFile(fileId)
  } catch (cause) {
    // The row is back on the shelf either way, which is what was asked for. What
    // is left is a folder in the bin that this shelf lists — worth saying, since
    // its takes will not play until it is restored from Drive itself.
    useWordsStore.setState({ syncError: toDisplayMessage(cause) })
  }
}

/** The three lists, in whatever state they are in. */
type Lists = Pick<WordsState, 'tiers' | 'languages' | 'words'>

type Selection = Pick<WordsState, 'selectedTierId' | 'selectedLanguageId' | 'selectedWordId'>

/** The first language of a tier and the first word of that, for the columns below it. */
function belowTier(
  lists: Lists,
  tierId: string | null,
): Pick<WordsState, 'selectedLanguageId' | 'selectedWordId'> {
  const language = languagesInTier(lists.languages, tierId)[0]
  return {
    selectedLanguageId: language?.id ?? null,
    selectedWordId: wordsInLanguage(lists.words, language?.id ?? null)[0]?.id ?? null,
  }
}

/** The first of each, which is what a page with nothing open yet should show. */
function openingSelection(lists: Lists): Selection {
  const tier = sortedTiers(lists.tiers)[0]
  return { selectedTierId: tier?.id ?? null, ...belowTier(lists, tier?.id ?? null) }
}

/**
 * Where the three columns should be pointing when the page is opened cold.
 *
 * Whatever this browser had open last time, checked against the shelf that is
 * actually here: a word deleted from another machine falls back to the first of
 * its column, exactly the way a sync landing on it would settle it.
 *
 * The exception is a browser whose local copy is empty — a machine that has
 * never had the page, or one whose storage was cleared. Settling ids against
 * three empty lists would null every one of them, so they are kept as they are
 * and the shelf arriving off the account a moment later settles them instead
 * (see `applyRemote`). Nothing is drawn from them in the meantime: a selection
 * naming rows the page does not have is the same empty page as no selection.
 */
function reopeningSelection(lists: Lists): Selection {
  const remembered = rememberedSelection()
  return lists.tiers.length === 0 ? remembered : settledSelection(remembered, lists)
}

/**
 * Where the three columns should be pointing after a read from Drive.
 *
 * Whatever was open stays open — a sync is not a reason to move somebody — and
 * anything that had nothing open, or had something that has since gone, takes
 * the first of what is there. That is what makes a second machine open on a
 * shelf rather than on a prompt.
 */
function settledSelection(selection: Selection, lists: Lists): Selection {
  const tier =
    lists.tiers.find((entry) => entry.id === selection.selectedTierId) ??
    sortedTiers(lists.tiers)[0]

  const inTier = languagesInTier(lists.languages, tier?.id ?? null)
  const language = inTier.find((entry) => entry.id === selection.selectedLanguageId) ?? inTier[0]

  const inLanguage = wordsInLanguage(lists.words, language?.id ?? null)
  const word = inLanguage.find((entry) => entry.id === selection.selectedWordId) ?? inLanguage[0]

  return {
    selectedTierId: tier?.id ?? null,
    selectedLanguageId: language?.id ?? null,
    selectedWordId: word?.id ?? null,
  }
}

/**
 * Applies a change to one word and writes the result down.
 *
 * Every edit to a word goes through here, which is what makes "each change is
 * saved" one rule rather than one per control — in IndexedDB now, and on the
 * account a beat later.
 */
function mapWord(words: readonly Word[], wordId: string, change: (word: Word) => Word): Word[] {
  markShelfDirty()
  return words.map((word) => {
    if (word.id !== wordId) return word
    const next = change(word)
    persistWord(next)
    return next
  })
}
