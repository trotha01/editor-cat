/**
 * The two halves of the word pages that are not this browser: the shelf on the
 * account, and the tree of folders in somebody's Drive.
 *
 * Every claim here is one that only breaks somewhere expensive to find out — on
 * a second machine, or a week later. A language whose folder is never made puts
 * its videos loose in the media folder. Two uploads racing to make the same
 * folder make two, and the shelf quietly forks. A delete that stops at this
 * browser is undone by the next read, which is a take coming back from the dead.
 * A shelf that is not written up is a morning's work that never leaves this
 * machine — and a shelf that is written up too eagerly is two tabs writing at
 * each other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'
import type { ShelfDoc } from '../lib/words'
import type { RawTier } from '../lib/wordsDrive'

const findOrCreateFolder = vi.fn<(name: string, parentId: string) => Promise<string>>()
const readShelf = vi.fn<() => Promise<RawTier[]>>(() => Promise.resolve([]))
const trashFile = vi.fn<(fileId: string) => Promise<void>>(() => Promise.resolve())
const renameFile = vi.fn<(fileId: string, name: string) => Promise<void>>(() => Promise.resolve())

const getShelf = vi.fn<() => Promise<{ doc: unknown; version: number } | null>>()
const putShelf = vi.fn<(doc: unknown, expected: number | null) => Promise<number | null>>()
const getAssets = vi.fn<(ids: string[]) => Promise<Record<string, unknown>[]>>()

vi.mock('../lib/wordsDrive', () => ({
  findOrCreateFolder: (name: string, parentId: string) => findOrCreateFolder(name, parentId),
  readShelf: () => readShelf(),
}))

vi.mock('../lib/google/drive', () => ({
  trashFile: (fileId: string) => trashFile(fileId),
  renameFile: (fileId: string, name: string) => renameFile(fileId, name),
  moveFile: () => Promise.resolve(),
}))

vi.mock('../lib/supabase/shelf', () => ({
  getShelf: () => getShelf(),
  putShelf: (doc: unknown, expected: number | null) => putShelf(doc, expected),
}))

vi.mock('../lib/supabase/assets', () => ({
  getAssets: (ids: string[]) => getAssets(ids),
  fromRow: (row: { id: string; name: string; drive_file_id: string | null }, blobKey: string) => ({
    id: row.id,
    kind: 'video',
    blobKey,
    mimeType: 'video/mp4',
    name: row.name,
    createdAt: 0,
    ...(row.drive_file_id ? { driveFileId: row.drive_file_id } : {}),
  }),
}))

const recordAsset = vi.fn<(asset: Asset) => Promise<void>>(() => Promise.resolve())

vi.mock('../lib/sync/assetSync', () => ({ recordAsset: (asset: Asset) => recordAsset(asset) }))

/** Whether there is an account to keep the shelf on, which is the other switch. */
let signedIn = true

vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))
vi.mock('./useAuthStore', () => ({ isSignedIn: () => signedIn }))

/** Whether there is a Drive to link to at all, which every call here starts from. */
let connected = true

vi.mock('./useDriveStore', () => ({
  useDriveStore: {
    getState: () => ({
      status: connected ? 'connected' : 'disconnected',
      folder: connected ? { id: 'root_folder', name: 'editor-cat' } : null,
    }),
  },
}))

const stored = new Map<string, unknown>()

/**
 * What this browser holds in IndexedDB, which is not the same thing as what the
 * catalogue has read out of it — the difference is the whole point of two of the
 * claims below.
 */
const storedAssets = new Map<string, Asset>()

vi.mock('../lib/db', () => ({
  listLanguages: () => Promise.resolve([]),
  listWords: () => Promise.resolve([]),
  putLanguage: (value: { id: string }) => {
    stored.set(value.id, value)
    return Promise.resolve()
  },
  putWord: (value: { id: string }) => {
    stored.set(value.id, value)
    return Promise.resolve()
  },
  deleteLanguage: () => Promise.resolve(),
  deleteTier: () => Promise.resolve(),
  deleteWord: () => Promise.resolve(),
  listTiers: () => Promise.resolve([]),
  putTier: (value: { id: string }) => {
    stored.set(value.id, value)
    return Promise.resolve()
  },
  putAsset: (value: Asset) => {
    storedAssets.set(value.id, value)
    return Promise.resolve()
  },
  getAsset: (id: string) => Promise.resolve(storedAssets.get(id)),
  deleteAsset: () => Promise.resolve(),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const { useWordsStore } = await import('./useWordsStore')
const { useAssetStore } = await import('./useAssetStore')

function asset(id: string, driveFileId?: string): Asset {
  return {
    id,
    kind: 'video',
    blobKey: `blob_${id}`,
    mimeType: 'video/mp4',
    name: `${id}.mp4`,
    createdAt: 0,
    ...(driveFileId ? { driveFileId } : {}),
  }
}

/** A tier, a language and a word, all already knowing their folders. */
function shelfWithGato() {
  useWordsStore.setState({
    tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0, driveFolderId: 'folder_first' }],
    languages: [
      {
        id: 'lang_es',
        tierId: 'tier_1',
        name: 'Spanish',
        createdAt: 0,
        driveFolderId: 'folder_es',
      },
    ],
    words: [
      {
        id: 'word_gato',
        languageId: 'lang_es',
        text: 'gato',
        videos: [],
        createdAt: 0,
        driveFolderId: 'folder_gato',
      },
    ],
    selectedTierId: 'tier_1',
    selectedLanguageId: 'lang_es',
    selectedWordId: 'word_gato',
  })
}

beforeEach(() => {
  connected = true
  signedIn = true
  stored.clear()
  storedAssets.clear()
  recordAsset.mockClear()
  localStorage.clear()
  findOrCreateFolder.mockReset()
  findOrCreateFolder.mockImplementation((name) => Promise.resolve(`folder_for_${name}`))
  readShelf.mockReset()
  readShelf.mockResolvedValue([])
  getShelf.mockReset()
  getShelf.mockResolvedValue(null)
  putShelf.mockReset()
  putShelf.mockResolvedValue(2)
  getAssets.mockReset()
  getAssets.mockResolvedValue([])
  trashFile.mockReset()
  trashFile.mockResolvedValue()
  renameFile.mockReset()
  renameFile.mockResolvedValue()

  useAssetStore.setState({ assets: [], loading: false })
  useWordsStore.setState({
    tiers: [],
    languages: [],
    words: [],
    selectedTierId: null,
    selectedLanguageId: null,
    selectedWordId: null,
    loading: false,
    loaded: true,
    syncing: false,
    syncError: null,
  })
})

describe('folders', () => {
  it('makes a tier its folder in the chosen folder as it is added', async () => {
    useWordsStore.getState().addTier('1st tier')
    await vi.waitFor(() =>
      expect(useWordsStore.getState().tiers[0]?.driveFolderId).toBe('folder_for_1st tier'),
    )

    expect(findOrCreateFolder).toHaveBeenCalledWith('1st tier', 'root_folder')
  })

  it('makes a language its folder inside its tier’s', async () => {
    useWordsStore.setState({
      tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0, driveFolderId: 'folder_first' }],
      selectedTierId: 'tier_1',
    })

    useWordsStore.getState().addLanguage('French')
    await vi.waitFor(() =>
      expect(useWordsStore.getState().languages[0]?.driveFolderId).toBe('folder_for_French'),
    )

    expect(findOrCreateFolder).toHaveBeenCalledWith('French', 'folder_first')
  })

  it('makes a word its folder inside its language’s', async () => {
    shelfWithGato()
    useWordsStore.setState({ words: [] })
    useWordsStore.getState().addWord('cerville - brain')
    await vi.waitFor(() =>
      expect(useWordsStore.getState().words[0]?.driveFolderId).toBe('folder_for_cerville - brain'),
    )

    expect(findOrCreateFolder).toHaveBeenCalledWith('cerville - brain', 'folder_es')
  })

  it('makes the whole chain for a word whose tier and language have no folders yet', async () => {
    useWordsStore.getState().addTier('ESL')
    useWordsStore.getState().addLanguage('German')
    useWordsStore.getState().addWord('hund - dog')
    const wordId = useWordsStore.getState().selectedWordId!

    expect(await useWordsStore.getState().ensureWordFolder(wordId)).toBe('folder_for_hund - dog')
    expect(findOrCreateFolder).toHaveBeenCalledWith('ESL', 'root_folder')
    expect(findOrCreateFolder).toHaveBeenCalledWith('German', 'folder_for_ESL')
    expect(findOrCreateFolder).toHaveBeenCalledWith('hund - dog', 'folder_for_German')
  })

  it('makes one folder when several uploads ask for it at once', async () => {
    useWordsStore.setState({
      tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0, driveFolderId: 'folder_first' }],
      languages: [
        {
          id: 'lang_es',
          tierId: 'tier_1',
          name: 'Spanish',
          createdAt: 0,
          driveFolderId: 'folder_es',
        },
      ],
      words: [{ id: 'word_gato', languageId: 'lang_es', text: 'gato', videos: [], createdAt: 0 }],
    })

    const asked = await Promise.all([
      useWordsStore.getState().ensureWordFolder('word_gato'),
      useWordsStore.getState().ensureWordFolder('word_gato'),
      useWordsStore.getState().ensureWordFolder('word_gato'),
    ])

    expect(asked).toEqual(['folder_for_gato', 'folder_for_gato', 'folder_for_gato'])
    expect(findOrCreateFolder).toHaveBeenCalledTimes(1)
  })

  it('answers with nothing at all when there is no Drive connected', async () => {
    connected = false
    useWordsStore.setState({
      tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0 }],
      languages: [{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }],
      words: [{ id: 'word_gato', languageId: 'lang_es', text: 'gato', videos: [], createdAt: 0 }],
    })

    expect(await useWordsStore.getState().ensureWordFolder('word_gato')).toBeNull()
    expect(findOrCreateFolder).not.toHaveBeenCalled()
  })
})

describe('the first read of an account with no shelf', () => {
  it('builds one out of the folders in Drive, and writes it up', async () => {
    readShelf.mockResolvedValue([
      {
        folderId: 'folder_first',
        name: '1st tier',
        languages: [
          {
            folderId: 'folder_es',
            name: 'Spanish',
            words: [
              {
                folderId: 'folder_gato',
                name: 'gato',
                files: [{ id: 'file_1', name: 'intro.mp4', mimeType: 'video/mp4' }],
                sidecar: {
                  version: 1,
                  word: 'gato',
                  videos: [{ driveFileId: 'file_1', role: 'intro' }],
                },
              },
            ],
          },
        ],
      },
    ])

    await useWordsStore.getState().syncShelf()

    const state = useWordsStore.getState()
    expect(state.tiers.map((entry) => entry.name)).toEqual(['1st tier'])
    expect(state.languages.map((entry) => entry.name)).toEqual(['Spanish'])
    expect(state.words[0]).toMatchObject({ text: 'gato', driveFolderId: 'folder_gato' })
    // The old file beside the videos is still read, once, for exactly this: the
    // order and the labels of somebody who was using the page before it moved.
    expect(state.words[0]?.videos[0]?.role).toBe('intro')

    // The file is in the catalogue, pointing at Drive and holding no bytes:
    // enough to draw the run, and what `useWordVideoBytes` fetches against.
    const catalogued = useAssetStore.getState().assets[0]
    expect(catalogued).toMatchObject({ name: 'intro.mp4', driveFileId: 'file_1', kind: 'video' })

    // And it opens on what just arrived rather than on an empty pair of columns.
    expect(state.selectedWordId).toBe(state.words[0]?.id)

    // The migration is the write: an insert, since there is no row to guard.
    await vi.waitFor(() => expect(putShelf).toHaveBeenCalled(), { timeout: 4000 })
    const [doc, expected] = putShelf.mock.calls[0] ?? []
    expect(expected).toBeNull()
    expect((doc as ShelfDoc).words[0]?.text).toBe('gato')
  })

  /**
   * The shelf this builds names its takes by asset id, so every one of those ids
   * has to be something the account can answer for. A file already in this
   * browser's catalogue is the case that got missed: nothing recorded a row for
   * a take catalogued out of the folder tree before the shelf moved, so a shelf
   * built out of them was a run of ids no second machine could ever resolve.
   */
  it('records a take it already knew, so the shelf it builds is resolvable elsewhere', async () => {
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    readShelf.mockResolvedValue([
      {
        folderId: 'folder_first',
        name: '1st tier',
        languages: [
          {
            folderId: 'folder_es',
            name: 'Spanish',
            words: [
              {
                folderId: 'folder_gato',
                name: 'gato',
                files: [{ id: 'file_1', name: 'intro.mp4', mimeType: 'video/mp4' }],
                sidecar: null,
              },
            ],
          },
        ],
      },
    ])

    await useWordsStore.getState().syncShelf()

    // Matched by its Drive id rather than catalogued a second time, and written
    // up all the same.
    expect(useWordsStore.getState().words[0]?.videos[0]?.assetId).toBe('asset_a')
    expect(recordAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'asset_a' }))
  })

  it('writes up the shelf this browser already has rather than reading Drive at all', async () => {
    shelfWithGato()

    await useWordsStore.getState().syncShelf()

    expect(readShelf).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(putShelf).toHaveBeenCalled(), { timeout: 4000 })
    expect((putShelf.mock.calls[0]?.[0] as ShelfDoc).words[0]?.text).toBe('gato')
  })
})

describe('reading the shelf off the account', () => {
  /** A stored shelf with one tier, one language and one word in it. */
  const storedShelf = (words: unknown[], version = 4) => ({
    version,
    doc: {
      version: 1,
      tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0, driveFolderId: 'folder_first' }],
      languages: [{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }],
      words,
    },
  })

  it('takes away a word deleted elsewhere, and the bytes it leaves stranded', async () => {
    shelfWithGato()
    // This browser has agreed with the account before, which is what makes the
    // word's absence up there a deletion rather than something never sent.
    localStorage.setItem('editor-cat.words.syncedAt.v1', '1000')
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    useWordsStore.getState().addVideo('word_gato', 'asset_a')
    getShelf.mockResolvedValue(storedShelf([]))

    await useWordsStore.getState().syncShelf()

    expect(useWordsStore.getState().words).toEqual([])
    expect(useAssetStore.getState().byId('asset_a')).toBeUndefined()
  })

  it('keeps a word added on this machine since the last write', async () => {
    shelfWithGato()
    // The last agreement with the account was before this word existed, which is
    // what tells it apart from one the account has deliberately dropped.
    localStorage.setItem('editor-cat.words.syncedAt.v1', '1000')
    useWordsStore.setState((state) => ({
      words: state.words.map((word) => ({ ...word, createdAt: 2000 })),
    }))
    getShelf.mockResolvedValue(storedShelf([]))

    await useWordsStore.getState().syncShelf()

    expect(useWordsStore.getState().words.map((word) => word.text)).toEqual(['gato'])
  })

  it('catalogues a take it has never held, so the run is more than a row of blanks', async () => {
    getShelf.mockResolvedValue(
      storedShelf([
        {
          id: 'word_gato',
          languageId: 'lang_es',
          text: 'gato',
          createdAt: 0,
          videos: [{ id: 'v1', assetId: 'asset_far', role: 'word' }],
        },
      ]),
    )
    getAssets.mockResolvedValue([{ id: 'asset_far', name: 'gato.mp4', drive_file_id: 'file_9' }])

    await useWordsStore.getState().syncShelf()

    expect(getAssets).toHaveBeenCalledWith(['asset_far'])
    expect(useAssetStore.getState().byId('asset_far')).toMatchObject({
      name: 'gato.mp4',
      driveFileId: 'file_9',
    })
  })

  /**
   * The catalogue loads on its own clock, from Root, and this runs off the back
   * of a network read that regularly gets there first. An id the catalogue has
   * not reached yet is not an id this browser has never held — and filing a
   * fresh entry over the top of one it has held gives the take a blob key
   * nothing has ever been stored under, which is a video that was on the machine
   * a moment ago and now will not play.
   */
  it('keeps the file this browser already holds, rather than filing a fresh entry over it', async () => {
    storedAssets.set('asset_far', asset('asset_far', 'file_9'))
    getShelf.mockResolvedValue(
      storedShelf([
        {
          id: 'word_gato',
          languageId: 'lang_es',
          text: 'gato',
          createdAt: 0,
          videos: [{ id: 'v1', assetId: 'asset_far', role: 'word' }],
        },
      ]),
    )
    getAssets.mockResolvedValue([{ id: 'asset_far', name: 'gato.mp4', drive_file_id: 'file_9' }])

    await useWordsStore.getState().syncShelf()

    // The stored entry, bytes and all — not a rebuild of it from the row.
    expect(useAssetStore.getState().byId('asset_far')?.blobKey).toBe('blob_asset_far')
  })

  /**
   * The other half of the same rule: the account is the only thing a machine
   * that has never held a take can resolve it against, so a take this one holds
   * and the account has never heard of gets written up rather than left as an id
   * that only works here.
   */
  it('writes up a take the account has no row for', async () => {
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    getShelf.mockResolvedValue(
      storedShelf([
        {
          id: 'word_gato',
          languageId: 'lang_es',
          text: 'gato',
          createdAt: 0,
          videos: [{ id: 'v1', assetId: 'asset_a', role: 'word' }],
        },
      ]),
    )
    getAssets.mockResolvedValue([])

    await useWordsStore.getState().syncShelf()

    expect(recordAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'asset_a' }))
  })

  it('says why when the account cannot be read, and keeps the shelf that is on screen', async () => {
    shelfWithGato()
    getShelf.mockRejectedValue(new Error('Supabase is having a moment.'))

    await useWordsStore.getState().syncShelf()

    expect(useWordsStore.getState().syncError).toContain('Supabase')
    expect(useWordsStore.getState().words).toHaveLength(1)
    expect(useWordsStore.getState().syncing).toBe(false)
  })

  it('does nothing at all with nobody signed in', async () => {
    signedIn = false

    await useWordsStore.getState().syncShelf()

    expect(getShelf).not.toHaveBeenCalled()
    expect(readShelf).not.toHaveBeenCalled()
  })
})

describe('deleting', () => {
  it('trashes the file behind a take, so a read does not bring it back', async () => {
    shelfWithGato()
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    useWordsStore.getState().addVideo('word_gato', 'asset_a')
    const videoId = useWordsStore.getState().selectedWord()!.videos[0]!.id

    await useWordsStore.getState().removeVideo('word_gato', videoId)

    expect(trashFile).toHaveBeenCalledWith('file_1')
  })

  it('leaves the file alone while another word still plays it', async () => {
    shelfWithGato()
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    useWordsStore.setState((state) => ({
      words: [
        ...state.words,
        { id: 'word_perro', languageId: 'lang_es', text: 'perro', videos: [], createdAt: 0 },
      ],
    }))
    useWordsStore.getState().addVideo('word_gato', 'asset_a')
    useWordsStore.getState().addVideo('word_perro', 'asset_a')
    const videoId = useWordsStore.getState().selectedWord()!.videos[0]!.id

    await useWordsStore.getState().removeVideo('word_gato', videoId)

    expect(trashFile).not.toHaveBeenCalled()
  })

  it('trashes a word’s folder, which takes its videos with it', async () => {
    shelfWithGato()

    await useWordsStore.getState().removeWord('word_gato')

    expect(trashFile).toHaveBeenCalledWith('folder_gato')
  })

  it('trashes a language’s folder', async () => {
    shelfWithGato()

    await useWordsStore.getState().removeLanguage('lang_es')

    expect(trashFile).toHaveBeenCalledWith('folder_es')
  })

  it('trashes a tier’s folder, which takes its languages and their words', async () => {
    shelfWithGato()

    await useWordsStore.getState().removeTier('tier_1')

    expect(trashFile).toHaveBeenCalledWith('folder_first')
    expect(useWordsStore.getState().languages).toEqual([])
    expect(useWordsStore.getState().words).toEqual([])
  })

  it('touches nobody’s Drive when there is no connection to it', async () => {
    connected = false
    shelfWithGato()

    await useWordsStore.getState().removeWord('word_gato')

    expect(trashFile).not.toHaveBeenCalled()
  })
})

describe('renaming', () => {
  it('renames the folder rather than making a new one, at every level', async () => {
    shelfWithGato()

    expect(useWordsStore.getState().renameTier('tier_1', '2nd tier')).toBe(true)
    expect(useWordsStore.getState().renameLanguage('lang_es', 'Castilian')).toBe(true)
    expect(useWordsStore.getState().renameWord('word_gato', 'gato - cat')).toBe(true)

    await vi.waitFor(() => expect(renameFile).toHaveBeenCalledTimes(3))
    expect(renameFile).toHaveBeenCalledWith('folder_first', '2nd tier')
    expect(renameFile).toHaveBeenCalledWith('folder_es', 'Castilian')
    expect(renameFile).toHaveBeenCalledWith('folder_gato', 'gato - cat')

    // And the names this browser holds, since the folder is only half of it.
    expect(useWordsStore.getState().tiers[0]?.name).toBe('2nd tier')
    expect(useWordsStore.getState().languages[0]?.name).toBe('Castilian')
    expect(useWordsStore.getState().words[0]?.text).toBe('gato - cat')
  })

  it('renames a take’s file, in the catalogue and in Drive', async () => {
    shelfWithGato()
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })

    useWordsStore.getState().renameVideo('asset_a', 'intro.webm')

    await vi.waitFor(() => expect(renameFile).toHaveBeenCalledWith('file_1', 'intro.webm'))
    expect(useAssetStore.getState().byId('asset_a')?.name).toBe('intro.webm')
  })

  it('refuses a name a sibling already has, and leaves both alone', () => {
    shelfWithGato()
    useWordsStore.getState().addLanguage('French')
    const french = useWordsStore.getState().selectedLanguageId!

    // Case and spacing included, the same way adding one is refused.
    expect(useWordsStore.getState().renameLanguage(french, ' spanish ')).toBe(false)
    expect(useWordsStore.getState().languages.map((entry) => entry.name)).toEqual([
      'Spanish',
      'French',
    ])
    expect(renameFile).not.toHaveBeenCalled()
  })

  it('allows a name another tier’s language has, since they are different shelves', () => {
    shelfWithGato()
    useWordsStore.getState().addTier('ESL')
    useWordsStore.getState().addLanguage('German')
    const german = useWordsStore.getState().selectedLanguageId!

    expect(useWordsStore.getState().renameLanguage(german, 'Spanish')).toBe(true)
  })

  it('touches nobody’s Drive with no connection to it', () => {
    connected = false
    shelfWithGato()

    expect(useWordsStore.getState().renameTier('tier_1', '2nd tier')).toBe(true)
    expect(renameFile).not.toHaveBeenCalled()
    expect(useWordsStore.getState().tiers[0]?.name).toBe('2nd tier')
  })
})

describe('writing the shelf up', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('is written once after a run of edits settles, not once per edit', async () => {
    vi.useRealTimers()
    shelfWithGato()
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    vi.useFakeTimers()

    const store = useWordsStore.getState()
    store.addVideo('word_gato', 'asset_a')
    const videoId = useWordsStore.getState().selectedWord()!.videos[0]!.id
    store.setVideoRole('word_gato', videoId, 'intro')
    store.setTranscript('word_gato', videoId, 'Ready?')

    expect(putShelf).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(putShelf).toHaveBeenCalledTimes(1)
    expect((putShelf.mock.calls[0]?.[0] as ShelfDoc).words[0]?.videos).toEqual([
      { id: videoId, assetId: 'asset_a', role: 'intro', transcript: 'Ready?' },
    ])

    vi.useRealTimers()
  })

  it('takes what is up there and writes again when somebody got in first', async () => {
    vi.useRealTimers()
    shelfWithGato()
    // Read once so this session has a version, then have that version go stale.
    getShelf.mockResolvedValue({
      version: 4,
      doc: { version: 1, tiers: [], languages: [], words: [] },
    })
    await useWordsStore.getState().syncShelf()
    getShelf.mockResolvedValue({
      version: 9,
      doc: {
        version: 1,
        tiers: [{ id: 'tier_2', name: 'ESL', createdAt: 0 }],
        languages: [],
        words: [],
      },
    })
    putShelf.mockResolvedValueOnce(null).mockResolvedValueOnce(10)
    vi.useFakeTimers()

    useWordsStore.getState().addTier('Classical')
    await vi.advanceTimersByTimeAsync(2000)

    // Their tier is on the shelf now, and so is the one added here, and the
    // second write is guarded by *their* version rather than our stale one.
    expect(useWordsStore.getState().tiers.map((entry) => entry.name)).toEqual(['ESL', 'Classical'])
    expect(putShelf).toHaveBeenLastCalledWith(expect.anything(), 9)

    vi.useRealTimers()
  })

  it('writes nothing with nobody signed in', async () => {
    signedIn = false
    shelfWithGato()

    useWordsStore.getState().addWord('perro')
    await vi.advanceTimersByTimeAsync(2000)

    expect(putShelf).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
