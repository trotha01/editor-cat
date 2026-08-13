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
 * And the same shelf is a tree of folders in the user's Drive: one per tier, one
 * per language inside it, one per word inside that, and that word's videos in
 * the word folder. The two are kept in step from here — every tier, language and
 * word gets its folder as it is made, every upload goes into the folder for its
 * word, every delete trashes what it was — so what IndexedDB holds is a fast
 * local copy of something that lives somewhere the user can open, and a second
 * machine reads the shelf back out of Drive rather than starting empty. Nothing
 * here needs Drive to work: with no connection the folder ids are simply absent,
 * and the page is the local one it was before.
 */
import { create } from 'zustand'
import {
  deleteLanguage as dbDeleteLanguage,
  deleteTier as dbDeleteTier,
  deleteWord as dbDeleteWord,
  listLanguages,
  listTiers,
  listWords,
  putAsset,
  putLanguage,
  putTier,
  putWord,
} from '../lib/db'
import {
  buildSidecar,
  findLanguage,
  findTier,
  findWord,
  isVideoAssetOrphaned,
  languagesInTier,
  mergeShelf,
  newLanguage,
  newTier,
  newWord,
  newWordVideo,
  sameName,
  sortedTiers,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type DiscoveredTier,
  type Language,
  type Tier,
  type Word,
  type WordVideoRole,
} from '../lib/words'
import { findOrCreateFolder, readShelf, writeSidecar, type RawTier } from '../lib/wordsDrive'
import { moveFile, renameFile, trashFile, type DriveFile } from '../lib/google/drive'
import { createScheduler } from '../lib/sync/scheduler'
import { newId } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
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
  /** True while the shelf is being read out of Drive. */
  syncing: boolean
  /** Why the last read of Drive failed, if it did. The local shelf still stands. */
  syncError: string | null

  /**
   * Reads both stores, then folds in whatever Drive holds. Does nothing on a
   * page that has already been opened.
   */
  load: () => Promise<void>
  /**
   * Reads the shelf out of Drive and folds it into this one.
   *
   * Additive: it can only bring languages, words and takes in, never take them
   * away, so a read that happens while the connection is patchy costs a delay
   * rather than a list. Deleting is what deletes.
   */
  syncFromDrive: () => Promise<void>
  /**
   * The Drive folder for a word, made — along with the language and tier folders
   * above it — if it is not there yet. Null when Drive is not connected, which
   * is the signal to carry on locally.
   */
  ensureWordFolder: (wordId: string) => Promise<string | null>

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
   * Puts videos that are already in Drive on the end of a word's run.
   *
   * For the files this app cannot see by itself: `drive.file` grants it what it
   * created and what the user hands it through the Picker, and nothing else — so
   * a take dropped into the word's folder from a phone is in the folder, in the
   * user's Drive, and invisible to the read of the shelf until it is picked.
   * This is what picking it does.
   *
   * Each one is moved into the word's folder if it is not there already, because
   * that folder is the word's list of takes and the next read rebuilds the run
   * from it — a take left elsewhere would show up now and be gone by morning.
   * The names it could not add come back, so the page can say which and why.
   */
  addDriveVideos: (wordId: string, files: readonly DriveFile[]) => Promise<string[]>
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

function persistTier(tier: Tier): void {
  void putTier(tier).catch(() => {})
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

/**
 * Videos whose Drive copy is what the sidecar is written from, so a word is
 * marked for a fresh one the moment an upload finishes rather than never.
 *
 * Without this, a take added and then left alone would be uploaded, listed in
 * the folder, and missing from the file that says what order the takes go in —
 * because at the moment the word changed, the upload had not finished and the
 * take had no Drive id to write down.
 */
let watchingUploads = false

function watchUploads(): void {
  if (watchingUploads) return
  watchingUploads = true

  const backedUp = () =>
    new Set(
      useAssetStore
        .getState()
        .assets.filter((asset) => asset.driveFileId)
        .map((asset) => asset.id),
    )

  let known = backedUp()
  useAssetStore.subscribe(() => {
    const next = backedUp()
    const fresh = [...next].filter((id) => !known.has(id))
    known = next
    if (fresh.length === 0) return

    for (const word of useWordsStore.getState().words) {
      if (word.videos.some((video) => fresh.includes(video.assetId))) markWordDirty(word.id)
    }
  })
}

/**
 * How long after the last edit the sidecar is rewritten.
 *
 * Long enough that dragging a run into order is one write rather than five, and
 * short enough that closing the tab a moment later has already saved it.
 */
const SIDECAR_DELAY = 1200

const dirtyWords = new Set<string>()

const sidecarWrites = createScheduler(async () => {
  const pending = [...dirtyWords]
  dirtyWords.clear()
  for (const wordId of pending) {
    try {
      await pushSidecar(wordId)
    } catch {
      // Best-effort, like every other write here: what is lost is the order and
      // the labels reaching the other machine, not the edit on this one.
    }
  }
}, SIDECAR_DELAY)

function markWordDirty(wordId: string): void {
  if (!driveRoot()) return
  dirtyWords.add(wordId)
  sidecarWrites.schedule()
}

async function pushSidecar(wordId: string): Promise<void> {
  const word = useWordsStore.getState().words.find((entry) => entry.id === wordId)
  if (!word) return
  const folderId = await useWordsStore.getState().ensureWordFolder(wordId)
  if (!folderId) return
  await writeSidecar(folderId, buildSidecar(word, driveFileIdOf))
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
          if (!asset) {
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

  load: async () => {
    // Before the early return, not after it: what this watches for — an upload
    // finishing — happens on every visit, while reading the stores happens on
    // the first one.
    watchUploads()

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
        // Opening on the first of each, so a page that has been used before
        // opens on something rather than on three empty columns and a prompt.
        ...openingSelection({ tiers, languages, words }),
      })
    } catch {
      // Nothing to show and nothing to be done about it from here. Not latched
      // as loaded: coming back to the page is a fair second try.
      set({ tiers: [], languages: [], words: [], loading: false })
    }

    // The local copy is on screen by now, and Drive is what says whether it is
    // the whole shelf. Not awaited by the caller for exactly that reason: a
    // machine that already has the words should draw them, not spin.
    void get().syncFromDrive()
  },

  syncFromDrive: async () => {
    const root = driveRoot()
    if (!root || get().syncing) return

    set({ syncing: true, syncError: null })
    try {
      const before = { tiers: get().tiers, languages: get().languages, words: get().words }
      const discovered = await adoptDiscovered(await readShelf(root))
      const merged = mergeShelf(before, discovered, driveFileIdOf)

      const tiers = settle(merged.tiers, before.tiers, persistTier)
      const languages = settle(merged.languages, before.languages, persistLanguage)
      const words = settle(merged.words, before.words, persistWord)
      set({
        tiers,
        languages,
        words,
        syncing: false,
        ...settledSelection(get(), { tiers, languages, words }),
      })

      // What a read can take away, it takes the stored copy and the bytes of
      // too: a word deleted on another machine otherwise leaves a row here and
      // takes nothing on this machine can reach. Storage that only ever grows is
      // the other way to lose somebody's work.
      await Promise.all([
        forgetOrphanedAssets(assetIdsOf(before.words), words),
        ...gone(before.words, words).map((word) => dbDeleteWord(word.id).catch(() => {})),
        ...gone(before.languages, languages).map((entry) =>
          dbDeleteLanguage(entry.id).catch(() => {}),
        ),
        ...gone(before.tiers, tiers).map((entry) => dbDeleteTier(entry.id).catch(() => {})),
      ])
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

  addTier: (name) => {
    const trimmed = name.trim()
    if (!trimmed) return

    const existing = findTier(get().tiers, trimmed)
    if (existing) {
      get().selectTier(existing.id)
      return
    }

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
    const doomedLanguages = get().languages.filter((language) => language.tierId === id)
    const doomedIds = new Set(doomedLanguages.map((language) => language.id))
    const doomedWords = get().words.filter((word) => doomedIds.has(word.languageId))
    const assetIds = assetIdsOf(doomedWords)
    const folderId = get().tiers.find((tier) => tier.id === id)?.driveFolderId

    const tiers = get().tiers.filter((tier) => tier.id !== id)
    const languages = get().languages.filter((language) => language.tierId !== id)
    const words = get().words.filter((word) => !doomedIds.has(word.languageId))
    set((state) => ({
      tiers,
      languages,
      words,
      ...(state.selectedTierId === id ? openingSelection({ tiers, languages, words }) : {}),
    }))

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
    const doomed = get().words.filter((word) => word.languageId === id)
    const assetIds = assetIdsOf(doomed)
    const folderId = get().languages.find((language) => language.id === id)?.driveFolderId

    const languages = get().languages.filter((language) => language.id !== id)
    const words = get().words.filter((word) => word.languageId !== id)
    set((state) => ({
      languages,
      words,
      ...(state.selectedLanguageId === id
        ? belowTier({ ...state, languages, words }, state.selectedTierId)
        : {}),
    }))

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

    const word = newWord(languageId, trimmed)
    persistWord(word)
    set((state) => ({ words: [...state.words, word], selectedWordId: word.id }))

    void get().ensureWordFolder(word.id)
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
    await trashInDrive(doomed.driveFolderId)
    await forgetOrphanedAssets(assetIdsOf([doomed]), words)
  },

  renameTier: (id, name) => {
    const trimmed = name.trim()
    const tier = get().tiers.find((entry) => entry.id === id)
    if (!tier || !trimmed || sameName(tier.name, trimmed)) return false

    const clash = findTier(get().tiers, trimmed)
    if (clash && clash.id !== id) return false

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

    // Through `mapWord`, which also marks the sidecar for rewriting — the file
    // beside the videos names the word it is for, and a stale name in it would
    // be the one the next machine reads.
    set((state) => ({ words: mapWord(state.words, id, (entry) => ({ ...entry, text: trimmed })) }))
    void renameInDrive(word.driveFolderId, trimmed)
    return true
  },

  renameVideo: (assetId, name) => {
    const trimmed = name.trim()
    const asset = useAssetStore.getState().byId(assetId)
    if (!asset || !trimmed || asset.name === trimmed) return

    void useAssetStore.getState().update(assetId, { name: trimmed })
    void renameInDrive(asset.driveFileId, trimmed)
  },

  addVideo: (wordId, assetId) => {
    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withVideo(word, newWordVideo(assetId))),
    }))
  },

  addDriveVideos: async (wordId, files) => {
    if (!get().words.some((entry) => entry.id === wordId)) return []

    // Asked for once, before the first file: the folder is the same for all of
    // them, and this is where a word that has never been in Drive gets one.
    const folderId = await get().ensureWordFolder(wordId)
    const failed: string[] = []

    for (const file of files) {
      try {
        const known = assetForDriveFile(file.id)
        // Picking a take the run already has is a no-op rather than a second
        // row: the Picker opens in the word's own folder, so the takes already
        // listed here are the ones most likely to be picked by mistake. Read
        // from the store each time, since the loop is adding to it.
        const run = get().words.find((entry) => entry.id === wordId)?.videos ?? []
        if (known && run.some((video) => video.assetId === known.id)) continue

        if (folderId) await moveFile(file.id, folderId)
        get().addVideo(wordId, (known ?? (await catalogueVideo(file))).id)
      } catch (cause) {
        // One take that would not move leaves the rest of the pick alone. The
        // video is still in Drive and still theirs; what failed is filing it.
        failed.push(`${file.name}: ${toDisplayMessage(cause)}`)
      }
    }

    return failed
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
    const driveFileId = assetId ? driveFileIdOf(assetId) : undefined

    set((state) => ({
      words: mapWord(state.words, wordId, (word) => withoutVideo(word, videoId)),
    }))

    if (!assetId) return
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
 * Puts a folder or a file in the Drive bin, if there is one and Drive is there
 * to take it.
 *
 * Deleting here really does delete over there, which is a departure from the
 * rest of the app — the Library is emphatic that your Drive copy is left alone.
 * The difference is that this shelf *is* the folder tree: a take removed from a
 * word and left sitting in that word's folder would simply be found again on the
 * next read, and come back from the dead. Drive's own bin is what makes that
 * safe rather than final.
 */
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

async function trashInDrive(fileId: string | undefined): Promise<void> {
  if (!fileId || !driveRoot()) return
  try {
    await trashFile(fileId)
  } catch (cause) {
    // Worth saying, and not worth undoing the delete over: what is left is an
    // item in Drive that this shelf no longer lists, which the next read will
    // offer back rather than lose.
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
 * Where the three columns should be pointing after a read from Drive.
 *
 * Whatever was open stays open — a sync is not a reason to move somebody — and
 * anything that had nothing open, or had something that has since gone, takes
 * the first of what is there. That is what makes a second machine open on a
 * shelf rather than on a prompt.
 */
function settledSelection(state: WordsState, lists: Lists): Selection {
  const tier =
    lists.tiers.find((entry) => entry.id === state.selectedTierId) ?? sortedTiers(lists.tiers)[0]

  const inTier = languagesInTier(lists.languages, tier?.id ?? null)
  const language = inTier.find((entry) => entry.id === state.selectedLanguageId) ?? inTier[0]

  const inLanguage = wordsInLanguage(lists.words, language?.id ?? null)
  const word = inLanguage.find((entry) => entry.id === state.selectedWordId) ?? inLanguage[0]

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
 * saved" one rule rather than one per control — locally, and in the file beside
 * the videos that carries the order and the labels to the next machine.
 */
function mapWord(words: readonly Word[], wordId: string, change: (word: Word) => Word): Word[] {
  markWordDirty(wordId)
  return words.map((word) => {
    if (word.id !== wordId) return word
    const next = change(word)
    persistWord(next)
    return next
  })
}
