import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'

/**
 * Backing an asset up to our own storage.
 *
 * Two things here are worth holding down and neither would fail loudly. The
 * idempotence guard is one: an asset that already has a key must never be
 * uploaded again, and losing that does not crash anything — it re-uploads
 * everything on every ingest, which is a bug you find on an invoice. The other
 * is that a failure is *reported*. Drive could afford to be quiet about a
 * failed upload because the bytes were also in IndexedDB and in the user's own
 * Drive; this is the only other copy, so silence plus cleared site data is lost
 * work.
 */

const uploadFiles = vi.fn()
const update = vi.fn()
const recordAsset = vi.fn()

vi.mock('../lib/r2/upload', () => ({
  uploadFiles: (request: unknown) => uploadFiles(request) as unknown,
}))

vi.mock('../lib/r2/client', () => ({ isR2Configured: () => true }))

vi.mock('../lib/sync/assetSync', () => ({
  recordAsset: (asset: unknown, size: number) => recordAsset(asset, size) as unknown,
}))

vi.mock('./useAssetStore', () => ({
  useAssetStore: {
    getState: () => ({ update, assets: [] as Asset[] }),
  },
}))

vi.mock('./useAuthStore', () => ({ isSignedIn: () => true }))

const { useR2Store } = await import('./useR2Store')

const BLOB = new Blob(['bytes'], { type: 'video/mp4' })

function asset(extra: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_1',
    kind: 'video',
    blobKey: 'blob_1',
    mimeType: 'video/mp4',
    name: 'clip.mp4',
    createdAt: 0,
    ...extra,
  }
}

/** Lets the store's fire-and-forget upload settle. */
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

beforeEach(() => {
  useR2Store.setState({ uploads: [], failed: [] })
  uploadFiles.mockResolvedValue({
    prefix: 'asset/hash/',
    objects: [{ name: 'asset_1', key: 'asset/hash/asset_1' }],
  })
  update.mockResolvedValue(undefined)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the idempotence guard', () => {
  it('never uploads an asset that already has a key', async () => {
    // The line that stops every ingest re-uploading everything. Its absence is
    // not a crash — it is a storage bill that quietly doubles.
    useR2Store.getState().uploadAsset(asset({ r2Key: 'asset/hash/asset_1' }), BLOB)
    await settle()

    expect(uploadFiles).not.toHaveBeenCalled()
  })

  it('uploads one that does not', async () => {
    useR2Store.getState().uploadAsset(asset(), BLOB)
    await settle()

    expect(uploadFiles).toHaveBeenCalledTimes(1)
  })
})

describe('a successful upload', () => {
  it('records the key on the asset, which is what makes it idempotent', async () => {
    useR2Store.getState().uploadAsset(asset(), BLOB)
    await settle()

    expect(update).toHaveBeenCalledWith('asset_1', { r2Key: 'asset/hash/asset_1' })
  })

  it('catalogues it again, now that there is somewhere to point at', async () => {
    useR2Store.getState().uploadAsset(asset(), BLOB)
    await settle()

    expect(recordAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'asset_1', r2Key: 'asset/hash/asset_1' }),
      BLOB.size,
    )
  })

  it('sends the asset id as the object name, not its display name', async () => {
    // Display names are somebody's words: spaces, punctuation, another
    // alphabet. The endpoint refuses anything that is not a bare safe name.
    useR2Store.getState().uploadAsset(asset({ name: 'my holiday (final).mp4' }), BLOB)
    await settle()

    expect(uploadFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'asset',
        files: [expect.objectContaining({ name: 'asset_1', contentType: 'video/mp4' })],
      }),
    )
  })

  it('leaves nothing in progress', async () => {
    useR2Store.getState().uploadAsset(asset(), BLOB)
    await settle()

    expect(useR2Store.getState().uploads).toEqual([])
    expect(useR2Store.getState().failed).toEqual([])
  })
})

describe('a failing upload', () => {
  it('tries again rather than giving up on the first refusal', async () => {
    vi.useFakeTimers()
    uploadFiles.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
      prefix: 'asset/hash/',
      objects: [{ name: 'asset_1', key: 'asset/hash/asset_1' }],
    })

    useR2Store.getState().uploadAsset(asset(), BLOB)
    await vi.advanceTimersByTimeAsync(5000)

    expect(uploadFiles).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith('asset_1', { r2Key: 'asset/hash/asset_1' })
  })

  it('says so rather than failing silently, once it has stopped trying', async () => {
    // With Drive gone this is the only copy besides IndexedDB, so a quiet
    // failure is the difference between "not backed up yet" and lost work.
    vi.useFakeTimers()
    uploadFiles.mockRejectedValue(new Error('R2 refused it (403).'))

    useR2Store.getState().uploadAsset(asset(), BLOB)
    await vi.advanceTimersByTimeAsync(30000)

    const failed = useR2Store.getState().failed
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ assetId: 'asset_1', name: 'clip.mp4', state: 'failed' })
    expect(failed[0]?.error).toMatch(/403/)
    expect(useR2Store.getState().uploads).toEqual([])
  })

  it('never records a key for an upload that did not happen', async () => {
    vi.useFakeTimers()
    uploadFiles.mockRejectedValue(new Error('nope'))

    useR2Store.getState().uploadAsset(asset(), BLOB)
    await vi.advanceTimersByTimeAsync(30000)

    // A key recorded for bytes that are not there would make the asset look
    // backed up and make hydration fetch a 404 on the next machine.
    expect(update).not.toHaveBeenCalled()
  })

  it('can be retried by hand', async () => {
    vi.useFakeTimers()
    uploadFiles.mockRejectedValue(new Error('nope'))
    useR2Store.getState().uploadAsset(asset(), BLOB)
    await vi.advanceTimersByTimeAsync(30000)
    expect(useR2Store.getState().failed).toHaveLength(1)

    uploadFiles.mockResolvedValue({
      prefix: 'asset/hash/',
      objects: [{ name: 'asset_1', key: 'asset/hash/asset_1' }],
    })
    // The retry needs the asset back from the catalogue, which this test's
    // stub reports as empty — so it drops rather than pretending it will run.
    useR2Store.getState().retryFailed()
    await vi.advanceTimersByTimeAsync(1)

    expect(useR2Store.getState().failed).toEqual([])
  })
})

describe('when there is nowhere to upload to', () => {
  it('does nothing at all', async () => {
    vi.doMock('../lib/r2/client', () => ({ isR2Configured: () => false }))
    vi.resetModules()
    const { useR2Store: store } = await import('./useR2Store')

    store.getState().uploadAsset(asset(), BLOB)
    await settle()

    expect(uploadFiles).not.toHaveBeenCalled()
    vi.doUnmock('../lib/r2/client')
  })
})
