import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../types'

/**
 * Moving what is in Drive into our own storage.
 *
 * The two properties worth holding down are both about somebody closing the
 * tab. It has to be idempotent, so a second run is nearly free and never
 * duplicates; and resumable, so the work already done survives — which means
 * each asset must be *recorded* before the next one is started, not batched up
 * and committed at the end.
 */

const listAssets = vi.fn()
const upsertAsset = vi.fn()
const downloadFile = vi.fn()
const uploadFiles = vi.fn()
const getBlob = vi.fn()
const putBlob = vi.fn()
const listLocalAssets = vi.fn()
const putAsset = vi.fn()
const adopt = vi.fn()

vi.mock('../supabase/assets', async () => {
  const actual = await vi.importActual<typeof import('../supabase/assets')>('../supabase/assets')
  return {
    ...actual,
    listAssets: () => listAssets() as unknown,
    upsertAsset: (asset: unknown, size?: number) => upsertAsset(asset, size) as unknown,
  }
})

// Only `downloadFile` is stubbed, which is also the assertion: the migration
// reads from Drive and writes nothing there. Any other Drive call would be
// undefined here and would fail the test that made it. Deleting somebody's
// files to tidy up is not this app's call.
vi.mock('../google/drive', () => ({
  downloadFile: (id: string, signal?: AbortSignal) => downloadFile(id, signal) as unknown,
}))

vi.mock('./upload', () => ({
  uploadFiles: (request: unknown) => uploadFiles(request) as unknown,
}))

vi.mock('../db', () => ({
  getBlob: (key: string) => getBlob(key) as unknown,
  putBlob: (key: string, blob: Blob) => putBlob(key, blob) as unknown,
  listAssets: () => listLocalAssets() as unknown,
  putAsset: (asset: unknown) => putAsset(asset) as unknown,
}))

// The catalogue on screen. A key that reaches Postgres and IndexedDB but not
// here is one that plays on the next reload and not before.
vi.mock('../../state/useAssetStore', () => ({
  useAssetStore: { getState: () => ({ adopt }) },
}))

const { countPending, migrateDriveToR2, pendingOf } = await import('./migrate')

const BLOB = new Blob(['bytes'], { type: 'video/mp4' })

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mime_type: 'video/mp4',
    width: null,
    height: null,
    duration: null,
    prompt: null,
    source_url: null,
    drive_file_id: `drive_${id}`,
    r2_key: null,
    byte_size: 5,
    created_at: '2026-08-11T12:00:00.000Z',
    ...extra,
  }
}

/**
 * A row as Postgres returns it when that column does not exist.
 *
 * The distinction this whole group turns on: `select('*')` omits an absent
 * column rather than reporting it as null, so the value is `undefined` — and
 * `undefined === null` is false.
 */
function withoutColumn(entry: ReturnType<typeof row>, column: string) {
  const copy: Record<string, unknown> = { ...entry }
  delete copy[column]
  return copy as ReturnType<typeof row>
}

/** This browser's own record of an asset, which is where `blobKey` lives. */
function localAsset(id: string, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: 'video',
    blobKey: `blob_${id}`,
    mimeType: 'video/mp4',
    name: `${id}.mp4`,
    createdAt: 0,
    driveFileId: `drive_${id}`,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listAssets.mockResolvedValue([row('a1'), row('a2')])
  listLocalAssets.mockResolvedValue([localAsset('a1'), localAsset('a2')])
  getBlob.mockResolvedValue(null)
  downloadFile.mockResolvedValue(BLOB)
  putBlob.mockResolvedValue(undefined)
  putAsset.mockResolvedValue(undefined)
  upsertAsset.mockResolvedValue(undefined)
  uploadFiles.mockImplementation(
    (request: { files: { name: string }[] }) =>
      Promise.resolve({
        prefix: 'asset/hash/',
        objects: request.files.map((file) => ({
          name: file.name,
          key: `asset/hash/${file.name}`,
        })),
      }) as unknown,
  )
})

describe('pendingOf', () => {
  const asset = (extra: Partial<Asset>): Asset => ({
    id: 'a',
    kind: 'video',
    blobKey: 'b',
    mimeType: 'video/mp4',
    name: 'a.mp4',
    createdAt: 0,
    ...extra,
  })

  it('is everything still only in Drive', () => {
    expect(pendingOf([asset({ driveFileId: 'd1' })])).toHaveLength(1)
  })

  it('skips anything already moved', () => {
    // What makes a second run nearly free.
    expect(pendingOf([asset({ driveFileId: 'd1', r2Key: 'asset/h/a' })])).toHaveLength(0)
  })

  it('skips anything that was never in Drive either', () => {
    expect(pendingOf([asset({})])).toHaveLength(0)
    expect(pendingOf([asset({ r2Key: 'asset/h/a' })])).toHaveLength(0)
  })
})

describe('countPending', () => {
  it('asks the account rather than this browser', async () => {
    // The local catalogue is only what this machine has heard about; the count
    // has to be honest on a second device.
    listAssets.mockResolvedValue([row('a1'), row('a2', { r2_key: 'asset/h/a2' }), row('a3')])
    listLocalAssets.mockResolvedValue([])
    await expect(countPending()).resolves.toEqual({ pending: 2, stale: 0, schema: 'ready' })
  })

  it('counts a record this browser holds that has not heard the file moved', async () => {
    // The state a migration leaves behind when it writes the key to the account
    // and nowhere else: the row says the bytes are in storage, this machine
    // does not, and the video does not play here.
    listAssets.mockResolvedValue([row('a1', { r2_key: 'asset/h/a1' })])
    listLocalAssets.mockResolvedValue([localAsset('a1')])

    await expect(countPending()).resolves.toEqual({ pending: 0, stale: 1, schema: 'ready' })
  })

  it('does not count one it has simply never heard of', async () => {
    // Absent, not stale. `hydrateProject` fetches those from the account when a
    // project needs them, key and all, so there is nothing here to fix.
    listAssets.mockResolvedValue([row('a1', { r2_key: 'asset/h/a1' })])
    listLocalAssets.mockResolvedValue([])

    await expect(countPending()).resolves.toMatchObject({ stale: 0 })
  })

  /**
   * `listAssets` selects `*`, so a column that does not exist yet is *absent*
   * from every row rather than null. Comparing it against null therefore
   * answers "no" for every asset, and the count comes out zero on a database
   * where in fact nothing has been moved at all.
   *
   * That failure is silent by shape: zero pending is also what a finished
   * account looks like, so the panel that would have explained it hides
   * itself, and a missing migration presents as a missing feature.
   */
  describe('a database that is not ready', () => {
    it('says 0010 has not been run, instead of reporting nothing to do', async () => {
      const first = withoutColumn(row('a1'), 'r2_key')
      const second = withoutColumn(row('a2', { drive_file_id: null }), 'r2_key')
      listAssets.mockResolvedValue([first, second])

      const result = await countPending()

      expect(result.schema).toBe('missing-r2-key')
      // Still a number, because it is exactly how many files are waiting on
      // that one migration being run.
      expect(result.pending).toBe(1)
    })

    it('goes quiet once 0011 has dropped the Drive column', async () => {
      // The intended end of all this. Nothing can be found in Drive any more,
      // and a permanent warning about a finished job is just noise.
      listAssets.mockResolvedValue([withoutColumn(row('a1'), 'drive_file_id')])

      await expect(countPending()).resolves.toEqual({
        pending: 0,
        stale: 0,
        schema: 'drive-id-dropped',
      })
    })
  })

  it('counts the same assets pendingOf would move', async () => {
    // The two answer the same question about the same rows, and a disagreement
    // shows up as a panel offering to move files it then skips.
    const rows = [
      row('a1'),
      row('a2', { r2_key: 'asset/h/a2' }),
      row('a3', { drive_file_id: null }),
    ]
    listAssets.mockResolvedValue(rows)

    const counted = (await countPending()).pending
    const moved = pendingOf(
      rows.map((entry) => ({
        id: entry.id,
        kind: 'video' as const,
        blobKey: entry.id,
        mimeType: 'video/mp4',
        name: entry.id,
        createdAt: 0,
        ...(entry.drive_file_id ? { driveFileId: entry.drive_file_id } : {}),
        ...(entry.r2_key ? { r2Key: entry.r2_key } : {}),
      })),
    ).length

    expect(counted).toBe(moved)
  })
})

describe('migrateDriveToR2', () => {
  it('moves every asset that is still only in Drive', async () => {
    const summary = await migrateDriveToR2()

    expect(uploadFiles).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ moved: 2, skipped: 0, failed: [] })
  })

  /**
   * The bug that made a successful migration look like a broken app.
   *
   * The key went to the account's row and nowhere else. But the row is what a
   * *second* machine reads; this one reads its own IndexedDB record and the
   * catalogue in memory, and both still said the asset had no key. So
   * `useWordVideoBytes` skipped every take at `!asset?.r2Key`, `planFor`
   * called it 'missing', and the migration reported moving everything while
   * every video stayed dark.
   */
  describe('recording where a file went', () => {
    it('tells the account, this browser, and the screen', async () => {
      await migrateDriveToR2()

      expect(upsertAsset).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', r2Key: 'asset/hash/a1' }),
        BLOB.size,
      )
      expect(putAsset).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', r2Key: 'asset/hash/a1' }),
      )
      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', r2Key: 'asset/hash/a1' }),
      )
    })

    it("keeps this browser's blob key rather than inventing one", async () => {
      // The account's table has no blob_key — it is per machine — so `fromRow`
      // has to be handed one. Minting a fresh id instead meant `getBlob` looked
      // where nothing was filed and `putBlob` stored the download somewhere
      // nothing would ever look, so the bytes were fetched and then lost.
      getBlob.mockResolvedValue(BLOB)

      await migrateDriveToR2()

      expect(getBlob).toHaveBeenCalledWith('blob_a1')
      expect(downloadFile).not.toHaveBeenCalled()
      expect(putAsset).toHaveBeenCalledWith(expect.objectContaining({ blobKey: 'blob_a1' }))
    })
  })

  describe('a browser left behind by an earlier run', () => {
    it('points it at files the account had already moved, without moving them again', async () => {
      // Nothing to download and nothing to upload: these files went across on
      // some previous run. All that is wrong is that this machine never heard,
      // which on its own is enough to leave every video dark.
      listAssets.mockResolvedValue([
        row('a1', { r2_key: 'asset/hash/a1' }),
        row('a2', { r2_key: 'asset/hash/a2' }),
      ])

      const summary = await migrateDriveToR2()

      expect(summary).toMatchObject({ moved: 0, reconciled: 2, failed: [] })
      expect(uploadFiles).not.toHaveBeenCalled()
      expect(downloadFile).not.toHaveBeenCalled()
      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', r2Key: 'asset/hash/a1', blobKey: 'blob_a1' }),
      )
    })

    it('leaves alone a record that already agrees', async () => {
      listAssets.mockResolvedValue([row('a1', { r2_key: 'asset/hash/a1' })])
      listLocalAssets.mockResolvedValue([localAsset('a1', { r2Key: 'asset/hash/a1' })])

      const summary = await migrateDriveToR2()

      expect(summary.reconciled).toBe(0)
      expect(putAsset).not.toHaveBeenCalled()
    })
  })

  it('records each key before starting the next, so a closed tab keeps the work', async () => {
    const order: string[] = []
    uploadFiles.mockImplementation((request: { files: { name: string }[] }) => {
      order.push(`upload:${request.files[0]?.name}`)
      return Promise.resolve({
        prefix: 'asset/hash/',
        objects: [{ name: request.files[0]?.name, key: `asset/hash/${request.files[0]?.name}` }],
      }) as unknown
    })
    upsertAsset.mockImplementation((asset: { id: string }) => {
      order.push(`record:${asset.id}`)
      return Promise.resolve(undefined) as unknown
    })

    await migrateDriveToR2()

    // Not upload, upload, record, record — that would lose the first asset's
    // key if the second upload hung.
    expect(order).toEqual(['upload:a1', 'record:a1', 'upload:a2', 'record:a2'])
  })

  it('skips what has already been moved', async () => {
    listAssets.mockResolvedValue([row('a1', { r2_key: 'asset/hash/a1' }), row('a2')])

    const summary = await migrateDriveToR2()

    expect(uploadFiles).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ moved: 1, skipped: 1 })
  })

  it('does nothing at all on a second run', async () => {
    listAssets.mockResolvedValue([
      row('a1', { r2_key: 'asset/hash/a1' }),
      row('a2', { r2_key: 'asset/hash/a2' }),
    ])

    const summary = await migrateDriveToR2()

    expect(downloadFile).not.toHaveBeenCalled()
    expect(uploadFiles).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ moved: 0, skipped: 2, failed: [] })
  })

  it('uses local bytes when this browser already has them', async () => {
    // The machine that made the work should not fetch it back from Drive only
    // to send it somewhere else.
    getBlob.mockResolvedValue(BLOB)

    await migrateDriveToR2()

    expect(downloadFile).not.toHaveBeenCalled()
    expect(uploadFiles).toHaveBeenCalledTimes(2)
  })

  it('keeps what it had to download, so the browser is faster afterwards', async () => {
    await migrateDriveToR2()
    expect(putBlob).toHaveBeenCalledTimes(2)
  })

  it('carries on past one file it cannot move', async () => {
    downloadFile.mockRejectedValueOnce(new Error('Drive said no'))

    const summary = await migrateDriveToR2()

    expect(summary.moved).toBe(1)
    expect(summary.failed).toEqual([
      { assetId: 'a1', name: 'a1.mp4', reason: expect.stringContaining('Drive said no') },
    ])
  })

  it('never records a key for an upload that did not happen', async () => {
    // A key with no bytes behind it makes an asset look migrated and makes the
    // next machine fetch a 404 — worse than not having moved it at all.
    uploadFiles.mockRejectedValue(new Error('R2 refused it'))

    const summary = await migrateDriveToR2()

    expect(upsertAsset).not.toHaveBeenCalled()
    expect(summary.failed).toHaveLength(2)
  })

  it('stops when asked, keeping what it has already finished', async () => {
    const controller = new AbortController()
    uploadFiles.mockImplementationOnce((request: { files: { name: string }[] }) => {
      controller.abort()
      return Promise.resolve({
        prefix: 'asset/hash/',
        objects: [{ name: request.files[0]?.name, key: `asset/hash/${request.files[0]?.name}` }],
      }) as unknown
    })

    const summary = await migrateDriveToR2({ signal: controller.signal })

    expect(uploadFiles).toHaveBeenCalledTimes(1)
    expect(summary.moved).toBe(1)
  })

  it('reports progress as it goes', async () => {
    const seen: { done: number; total: number }[] = []
    await migrateDriveToR2({ onProgress: (p) => seen.push({ done: p.done, total: p.total }) })

    expect(seen[0]).toEqual({ done: 0, total: 2 })
    expect(seen.at(-1)).toEqual({ done: 2, total: 2 })
  })
})
