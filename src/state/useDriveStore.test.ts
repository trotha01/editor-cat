import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'

const uploadFile = vi.fn()
const update = vi.fn()

vi.mock('../lib/google/gis', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  accessToken: vi.fn(),
  isDriveConfigured: () => true,
  NeedsConsentError: class extends Error {},
}))

class FakeDriveError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`drive ${status}`)
    this.status = status
  }
}

vi.mock('../lib/google/drive', () => ({
  currentUser: vi.fn(),
  DriveError: FakeDriveError,
  uploadFile: (...args: unknown[]) => uploadFile(...args) as unknown,
}))

vi.mock('./useAssetStore', () => ({
  useAssetStore: { getState: () => ({ update }) },
}))

const { useDriveStore } = await import('./useDriveStore')

const asset = (extra: Partial<Asset> = {}): Asset => ({
  id: 'asset_1',
  kind: 'image',
  blobKey: 'blob_1',
  mimeType: 'image/png',
  name: 'shot.png',
  createdAt: 0,
  ...extra,
})

const blob = new Blob(['bytes'], { type: 'image/png' })

/** Lets the fire-and-forget upload chain settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  useDriveStore.setState({
    status: 'connected',
    account: null,
    folder: { id: 'folder_1', name: 'Renders' },
    error: null,
    uploads: [],
  })
})

describe('setFolder', () => {
  it('persists the choice so a reload keeps saving to the same place', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    expect(window.localStorage.getItem('editor-cat.drive.folder.v1')).toBe(
      JSON.stringify({ id: 'folder_2', name: 'B-roll' }),
    )
  })

  it('clears the stored folder when unset', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })
    useDriveStore.getState().setFolder(null)

    expect(window.localStorage.getItem('editor-cat.drive.folder.v1')).toBeNull()
  })
})

describe('uploadAsset', () => {
  it('uploads into the chosen folder and records the resulting file id', async () => {
    uploadFile.mockResolvedValue({ id: 'drive_9', name: 'shot.png', mimeType: 'image/png' })

    useDriveStore.getState().uploadAsset(asset(), blob)
    await flush()

    expect(uploadFile).toHaveBeenCalledWith(
      blob,
      expect.objectContaining({ name: 'shot.png', parentId: 'folder_1' }),
    )
    expect(update).toHaveBeenCalledWith('asset_1', { driveFileId: 'drive_9' })
    // The job disappears once it is safely in Drive.
    expect(useDriveStore.getState().uploads).toEqual([])
  })

  it('does nothing for an asset that already came from Drive', () => {
    useDriveStore.getState().uploadAsset(asset({ driveFileId: 'drive_existing' }), blob)

    expect(uploadFile).not.toHaveBeenCalled()
    expect(useDriveStore.getState().uploads).toEqual([])
  })

  it('does nothing while disconnected', () => {
    useDriveStore.setState({ status: 'needs-reconnect' })

    useDriveStore.getState().uploadAsset(asset(), blob)

    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('does nothing when no folder has been chosen yet', () => {
    useDriveStore.setState({ folder: null })

    useDriveStore.getState().uploadAsset(asset(), blob)

    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('keeps a failed upload visible with its reason, since the bytes are still local', async () => {
    uploadFile.mockRejectedValue(new Error('Your Google Drive is full.'))

    useDriveStore.getState().uploadAsset(asset(), blob)
    await flush()

    expect(useDriveStore.getState().uploads).toEqual([
      expect.objectContaining({ assetId: 'asset_1', error: 'Your Google Drive is full.' }),
    ])
  })

  it('flags the connection as stale when an upload fails on an expired session', async () => {
    uploadFile.mockRejectedValue(new FakeDriveError(401))

    useDriveStore.getState().uploadAsset(asset(), blob)
    await flush()

    // Otherwise Settings keeps claiming Drive is connected while every
    // subsequent backup silently fails the same way.
    expect(useDriveStore.getState().status).toBe('needs-reconnect')
  })

  it('leaves the connection alone for an ordinary upload failure', async () => {
    uploadFile.mockRejectedValue(new FakeDriveError(507))

    useDriveStore.getState().uploadAsset(asset(), blob)
    await flush()

    expect(useDriveStore.getState().status).toBe('connected')
  })

  it('reports progress as the upload runs', async () => {
    uploadFile.mockImplementation(
      async (_blob: Blob, options: { onProgress?: (fraction: number) => void }) => {
        options.onProgress?.(0.5)
        return { id: 'drive_9', name: 'shot.png', mimeType: 'image/png' }
      },
    )

    useDriveStore.getState().uploadAsset(asset(), blob)
    // Sampled before the upload resolves and the row is removed.
    expect(useDriveStore.getState().uploads[0]?.progress).toBe(0.5)

    await flush()
    expect(useDriveStore.getState().uploads).toEqual([])
  })
})
