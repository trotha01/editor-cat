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
  type Language,
  type Shelf,
  type Tier,
  type Word,
  type WordVideoRole,
} from '../lib/words'
import { fromRow, getAssets } from '../lib/supabase/assets'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { getShelf, putShelf } from '../lib/supabase/shelf'
import { createScheduler } from '../lib/sync/scheduler'
import { recordAsset } from '../lib/sync/assetSync'
import { ingestBlob, newId } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { isSignedIn } from './useAuthStore'
import { useAssetStore } from './useAssetStore'

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
   * Labels one take, or takes its label off — `undefined` is a label somebody
   * chose to remove, not a missing argument. Only the takes between the ends of
   * a run have anything to say here; see `roleInRun`.
   */
  setVideoRole: (wordId: string, videoId: string, role: WordVideoRole | undefined) => void
  setTranscript: (wordId: string, videoId: string, transcript: string) => void
  moveVideo: (wordId: string, from: number, to: number) => void
  removeVideo: (wordId: string, videoId: string) => Promise<void>
  /**
   * Points a take at the asset its file was just recovered into.
   *
   * For `lib/r2/recoverShelf.ts` and nothing else. Deliberately not an undo
   * step: what this changes is a pointer that was broken, and offering to put
   * it back the way it was — pointing at nothing — is not a thing anybody
   * means by Ctrl+Z. Same reasoning as `recordPublication` on the project
   * store.
   */
  repairVideo: (wordId: string, videoId: string, assetId: string) => void
  /**
   * Writes the shelf up now rather than after the quiet period.
   *
   * For anything that has just made a burst of changes and then wants to ask
   * the *account* a question about them. Shelf writes are debounced by
   * `SHELF_DELAY`, and every change resets it — so a hundred repairs in a row
   * push once, 1.2s after the last one, and a read taken before that gets a
   * snapshot from the middle of the run. See `lib/r2/recoverShelf.ts`.
   */
  flushShelf: () => Promise<void>

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

async function hydrateShelfAssets(words: readonly Word[]): Promise<void> {
  const ids = [...new Set(assetIdsOf(words))]
  if (ids.length === 0) return

  const rows = new Map((await getAssets(ids)).map((row) => [row.id, row] as const))

  for (const id of ids) {
    // Read afresh each time round rather than snapshotted: the catalogue's own
    // load can land in the middle of this, and so can the line below.
    const held = useAssetStore.getState().byId(id) ?? (await getAsset(id))
    const row = rows.get(id)

    if (held) {
      if (!row) {
        void recordAsset(held)
        if (!useAssetStore.getState().byId(id)) useAssetStore.getState().adopt(held)
        continue
      }

      // The account can know something this record does not. An `r2_key`
      // written by the Drive migration, or by another machine's upload, lands
      // on the row and never reaches a browser that already had its own copy
      // of the metadata — and this used to take `held` and never look. A take
      // whose bytes are sitting in storage then read as "not on this machine"
      // for good, because `useWordVideoBytes` skips anything with no key.
      //
      // The blob key stays local: it names an IndexedDB entry on this machine
      // and nothing anywhere else.
      const merged = row.r2_key && held.r2Key !== row.r2_key ? { ...held, r2Key: row.r2_key } : held
      if (merged !== held) await putAsset(merged)
      if (merged !== held || !useAssetStore.getState().byId(id)) {
        useAssetStore.getState().adopt(merged)
      }
      continue
    }

    if (!row) continue
    // A blob key names an IndexedDB entry on one machine and nothing anywhere
    // else, so it is made here rather than carried.
    const asset = fromRow(row, newId('blob'))
    await putAsset(asset)
    useAssetStore.getState().adopt(asset)
  }
}

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

function restoreShelf(next: Shelf): void {
  const before = lists()

  const tiers = settle(next.tiers, before.tiers, storeTier)
  const languages = settle(next.languages, before.languages, storeLanguage)
  const words = settle(next.words, before.words, storeWord)

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
  })()
}

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
      for (const [done, file] of chosen.entries()) {
        set({ uploading: { wordId, done, total: chosen.length } })
        // Worth saying rather than skipping quietly: dropping a folder, or the
        // wrong file out of a folder of takes, is easy to do and leaves a run
        // that is simply one short.
        if (!file.type.startsWith('video/')) {
          set({ uploadError: `"${file.name}" is not a video.` })
          continue
        }
        const asset = await ingestBlob(file, { kind: 'video', name: file.name })
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

  setVideoRole: (wordId, videoId, role) => {
    recordStep()
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { role })),
    }))
  },

  repairVideo: (wordId, videoId, assetId) => {
    // No `recordStep`: see the declaration. `mapWord` still persists and marks
    // the shelf dirty, which is what carries the repair to the account so the
    // next machine does not have to do it again.
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideoPatch(word, videoId, { assetId })),
    }))
  },

  flushShelf: async () => {
    await shelfWrites.flush()
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

    recordStep()
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withoutVideo(word, videoId)),
    }))

    // Only once nothing else lists it, and for the same reason the bytes go:
    // another word playing the same take still wants the file it plays.
    if (isVideoAssetOrphaned(assetId, get().words))
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

/** The three lists, in whatever state they are in. */
type Lists = Pick<WordsState, 'tiers' | 'languages' | 'words'>

type Selection = Pick<WordsState, 'selectedTierId' | 'selectedLanguageId' | 'selectedWordId'>

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
