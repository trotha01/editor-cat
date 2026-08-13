/**
 * The half of the word pages that is a tree of folders in somebody's Drive.
 *
 * Every claim here is one that only breaks somewhere expensive to find out —
 * on a second machine, or a week later. A language whose folder is never made
 * puts its videos loose in the media folder. Two uploads racing to make the same
 * folder make two, and the shelf quietly forks. A delete that stops at this
 * browser is undone by the next read, which is a take coming back from the dead.
 * And a sidecar that is not written is an order and a set of labels that never
 * leave this machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'
import type { WordSidecar } from '../lib/words'
import type { RawTier } from '../lib/wordsDrive'

const findOrCreateFolder = vi.fn<(name: string, parentId: string) => Promise<string>>()
const readShelf = vi.fn<() => Promise<RawTier[]>>(() => Promise.resolve([]))
const writeSidecar = vi.fn<(folderId: string, sidecar: WordSidecar) => Promise<void>>(() =>
  Promise.resolve(),
)
const trashFile = vi.fn<(fileId: string) => Promise<void>>(() => Promise.resolve())

vi.mock('../lib/wordsDrive', () => ({
  findOrCreateFolder: (name: string, parentId: string) => findOrCreateFolder(name, parentId),
  readShelf: () => readShelf(),
  writeSidecar: (folderId: string, sidecar: WordSidecar) => writeSidecar(folderId, sidecar),
}))

vi.mock('../lib/google/drive', () => ({
  trashFile: (fileId: string) => trashFile(fileId),
}))

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
  putAsset: () => Promise.resolve(),
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
  stored.clear()
  findOrCreateFolder.mockReset()
  findOrCreateFolder.mockImplementation((name) => Promise.resolve(`folder_for_${name}`))
  readShelf.mockReset()
  readShelf.mockResolvedValue([])
  writeSidecar.mockReset()
  writeSidecar.mockResolvedValue()
  trashFile.mockReset()
  trashFile.mockResolvedValue()

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

describe('reading the shelf out of Drive', () => {
  it('brings in the languages, words and takes, and catalogues the files', async () => {
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

    await useWordsStore.getState().syncFromDrive()

    const state = useWordsStore.getState()
    expect(state.tiers.map((entry) => entry.name)).toEqual(['1st tier'])
    expect(state.languages.map((entry) => entry.name)).toEqual(['Spanish'])
    expect(state.words[0]).toMatchObject({ text: 'gato', driveFolderId: 'folder_gato' })
    expect(state.words[0]?.videos[0]?.role).toBe('intro')

    // The file is in the catalogue, pointing at Drive and holding no bytes:
    // enough to draw the run, and what `useWordVideoBytes` fetches against.
    const catalogued = useAssetStore.getState().assets[0]
    expect(catalogued).toMatchObject({ name: 'intro.mp4', driveFileId: 'file_1', kind: 'video' })

    // And it opens on what just arrived rather than on an empty pair of columns.
    expect(state.selectedWordId).toBe(state.words[0]?.id)
  })

  it('takes away a word deleted elsewhere, and the bytes it leaves stranded', async () => {
    shelfWithGato()
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')], loading: false })
    useWordsStore.getState().addVideo('word_gato', 'asset_a')
    // Drive has nothing under the root any more: the word was deleted from
    // another machine, which trashed its folder.
    readShelf.mockResolvedValue([])

    await useWordsStore.getState().syncFromDrive()

    expect(useWordsStore.getState().words).toEqual([])
    expect(useAssetStore.getState().byId('asset_a')).toBeUndefined()
  })

  it('says why when Drive cannot be read, and keeps the shelf that is on screen', async () => {
    shelfWithGato()
    readShelf.mockRejectedValue(new Error('Google Drive is having a moment.'))

    await useWordsStore.getState().syncFromDrive()

    expect(useWordsStore.getState().syncError).toContain('Google Drive')
    expect(useWordsStore.getState().words).toHaveLength(1)
    expect(useWordsStore.getState().syncing).toBe(false)
  })

  it('does nothing at all with no Drive connected', async () => {
    connected = false
    await useWordsStore.getState().syncFromDrive()

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

describe('the file beside the videos', () => {
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

    expect(writeSidecar).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(writeSidecar).toHaveBeenCalledTimes(1)
    expect(writeSidecar).toHaveBeenCalledWith('folder_gato', {
      version: 1,
      word: 'gato',
      videos: [{ driveFileId: 'file_1', role: 'intro', transcript: 'Ready?' }],
    })

    vi.useRealTimers()
  })

  it('is written again when an upload finishes and the take finally has a file', async () => {
    vi.useRealTimers()
    shelfWithGato()
    // Ingested but not yet uploaded: nothing in Drive to name it by, so the
    // first write cannot mention it.
    useAssetStore.setState({ assets: [asset('asset_a')], loading: false })
    // `load` is what starts watching for uploads finishing.
    await useWordsStore.getState().load()
    vi.useFakeTimers()

    useWordsStore.getState().addVideo('word_gato', 'asset_a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(writeSidecar).toHaveBeenLastCalledWith(
      'folder_gato',
      expect.objectContaining({ videos: [] }),
    )

    // The upload lands, which is the asset gaining a Drive id.
    useAssetStore.setState({ assets: [asset('asset_a', 'file_1')] })
    await vi.advanceTimersByTimeAsync(2000)

    expect(writeSidecar).toHaveBeenLastCalledWith('folder_gato', {
      version: 1,
      word: 'gato',
      videos: [{ driveFileId: 'file_1', role: 'word' }],
    })

    vi.useRealTimers()
  })
})
