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

vi.mock('./client', () => ({ isR2Configured: () => true }))

vi.mock('../db', () => ({
  getBlob: (key: string) => getBlob(key) as unknown,
  putBlob: (key: string, blob: Blob) => putBlob(key, blob) as unknown,
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

beforeEach(() => {
  vi.clearAllMocks()
  listAssets.mockResolvedValue([row('a1'), row('a2')])
  getBlob.mockResolvedValue(null)
  downloadFile.mockResolvedValue(BLOB)
  putBlob.mockResolvedValue(undefined)
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
    await expect(countPending()).resolves.toBe(2)
  })
})

describe('migrateDriveToR2', () => {
  it('moves every asset that is still only in Drive', async () => {
    const summary = await migrateDriveToR2()

    expect(uploadFiles).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ moved: 2, skipped: 0, failed: [] })
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
