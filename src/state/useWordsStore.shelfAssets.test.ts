import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'
import type { Word } from '../lib/words'

/**
 * Resolving a word's takes against the account's asset rows.
 *
 * This has one job that is easy to get subtly wrong: deciding what to do when
 * *both* this browser and the account have a record of the same asset. The
 * blob key can only come from here — it names an IndexedDB entry on this
 * machine and nothing anywhere else. Everything else can be fresher on the
 * account, because another machine, or a migration, may have written it.
 *
 * Taking the local record wholesale is the bug this file exists for, and it
 * has an unusually quiet failure: `useWordVideoBytes` skips any asset with no
 * `r2Key`, so a take whose bytes are sitting in storage reads as "not on this
 * machine" — which is exactly what it read before the bytes got there. Nothing
 * errors, nothing is logged, and the run just shows as empty.
 */
const getAssets = vi.fn()
const recordAsset = vi.fn()
const putAsset = vi.fn()
const getAsset = vi.fn()
const getShelf = vi.fn()

vi.mock('../lib/supabase/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/supabase/assets')>()),
  getAssets: (ids: string[]) => getAssets(ids) as unknown,
}))

vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))
vi.mock('./useAuthStore', () => ({ isSignedIn: () => true }))
vi.mock('../lib/sync/assetSync', () => ({
  recordAsset: (asset: unknown) => recordAsset(asset) as unknown,
}))

vi.mock('../lib/supabase/shelf', () => ({
  SHELF_SCHEMA_VERSION: 1,
  getShelf: () => getShelf() as unknown,
  putShelf: () => Promise.resolve(1),
}))

const WORD: Word = {
  id: 'w1',
  languageId: 'lang_es',
  text: 'gato',
  videos: [{ id: 'wv1', assetId: 'asset_1', role: 'word' }],
  createdAt: 0,
}

vi.mock('../lib/db', () => ({
  listTiers: () => Promise.resolve([{ id: 'tier_1', name: '1st tier', createdAt: 0 }]),
  listLanguages: () =>
    Promise.resolve([{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }]),
  listWords: () => Promise.resolve([WORD]),
  putTier: () => Promise.resolve(),
  putLanguage: () => Promise.resolve(),
  putWord: () => Promise.resolve(),
  deleteTier: () => Promise.resolve(),
  deleteLanguage: () => Promise.resolve(),
  deleteWord: () => Promise.resolve(),
  deleteAsset: () => Promise.resolve(),
  putAsset: (asset: unknown) => putAsset(asset) as unknown,
  getAsset: (id: string) => getAsset(id) as unknown,
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const { useWordsStore } = await import('./useWordsStore')
const { useAssetStore } = await import('./useAssetStore')

/** The account's row for the take, which has been moved into storage. */
function assetRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'asset_1',
    kind: 'video',
    name: 'take.mp4',
    mime_type: 'video/mp4',
    width: null,
    height: null,
    duration: null,
    prompt: null,
    source_url: null,
    r2_key: 'asset/hash/asset_1',
    byte_size: 10,
    created_at: '2026-08-11T12:00:00.000Z',
    ...extra,
  }
}

/** This browser's own record, written before anything moved. */
function localRecord(extra: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_1',
    kind: 'video',
    blobKey: 'blob_local',
    mimeType: 'video/mp4',
    name: 'take.mp4',
    createdAt: 0,
    ...extra,
  }
}

/** The shelf as the account stores it, with the take on the word. */
const SHELF_DOC = {
  tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0 }],
  languages: [{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }],
  words: [WORD],
}

beforeEach(() => {
  vi.clearAllMocks()
  getShelf.mockResolvedValue({ doc: SHELF_DOC, version: 1 })
  getAsset.mockResolvedValue(undefined)
  putAsset.mockResolvedValue(undefined)
  getAssets.mockResolvedValue([assetRow()])
  useAssetStore.setState({ assets: [], loading: false })
  useWordsStore.setState({
    tiers: [],
    languages: [],
    words: [],
    selectedTierId: null,
    selectedLanguageId: null,
    selectedWordId: null,
    loading: false,
    loaded: false,
    uploading: null,
    uploadError: null,
    past: [],
    future: [],
  })
  localStorage.clear()
})

describe('a take this browser already has a record of', () => {
  it('learns the storage key the account knows and it does not', async () => {
    useAssetStore.setState({ assets: [localRecord()], loading: false })

    await useWordsStore.getState().syncShelf()

    expect(useAssetStore.getState().byId('asset_1')?.r2Key).toBe('asset/hash/asset_1')
  })

  it('keeps its own blob key, which the account cannot know', async () => {
    // The account's table has no blob_key: it names an IndexedDB entry on one
    // machine and nothing anywhere else. Taking the row's word for it would
    // orphan the bytes this browser already holds.
    useAssetStore.setState({ assets: [localRecord()], loading: false })

    await useWordsStore.getState().syncShelf()

    expect(useAssetStore.getState().byId('asset_1')?.blobKey).toBe('blob_local')
  })

  it('writes the merged record down, so a reload does not lose it again', async () => {
    useAssetStore.setState({ assets: [localRecord()], loading: false })

    await useWordsStore.getState().syncShelf()

    expect(putAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'asset_1',
        r2Key: 'asset/hash/asset_1',
        blobKey: 'blob_local',
      }),
    )
  })

  it('leaves a record that already agrees untouched', async () => {
    useAssetStore.setState({
      assets: [localRecord({ r2Key: 'asset/hash/asset_1' })],
      loading: false,
    })

    await useWordsStore.getState().syncShelf()

    expect(putAsset).not.toHaveBeenCalled()
  })

  it('still catalogues a take the account has never heard of', async () => {
    // The other direction, and the one that was already right: a file made on
    // this machine and not yet synced is still the take, and dropping it
    // because the account has no row would empty a word somebody just filmed.
    getAssets.mockResolvedValue([])
    getAsset.mockResolvedValue(localRecord())

    await useWordsStore.getState().syncShelf()

    expect(useAssetStore.getState().byId('asset_1')).toBeDefined()
    expect(recordAsset).toHaveBeenCalled()
  })
})
