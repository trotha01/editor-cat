import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'

const uploadFile = vi.fn()
const update = vi.fn()
const connect = vi.fn()
const disconnect = vi.fn()
const accessToken = vi.fn()
const loadConnectionStatus = vi.fn<() => Promise<{ durable: boolean; connected: boolean }>>()
const isDurableConnection = vi.fn<() => boolean | null>(() => null)
const adoptConnection = vi.fn()
const invalidateToken = vi.fn()

class FakeNeedsConsentError extends Error {}

vi.mock('../lib/google/gis', () => ({
  adoptConnection: (code: string) => adoptConnection(code) as unknown,
  connect: (...args: unknown[]) => connect(...args) as unknown,
  disconnect: (...args: unknown[]) => disconnect(...args) as unknown,
  accessToken: (...args: unknown[]) => accessToken(...args) as unknown,
  invalidateToken: () => invalidateToken(),
  isDriveConfigured: () => true,
  isDurableConnection: () => isDurableConnection(),
  loadConnectionStatus: () => loadConnectionStatus(),
  NeedsConsentError: FakeNeedsConsentError,
}))

class FakeDriveError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`drive ${status}`)
    this.status = status
  }
}

const currentUser = vi.fn(async () => ({ email: 'someone@example.com', name: 'Someone' }))

vi.mock('../lib/google/drive', () => ({
  currentUser: () => currentUser(),
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
  currentUser.mockResolvedValue({ email: 'someone@example.com', name: 'Someone' })
  loadConnectionStatus.mockResolvedValue({ durable: false, connected: false })
  isDurableConnection.mockReturnValue(null)
  adoptConnection.mockResolvedValue('stored-token')
  useDriveStore.setState({
    status: 'connected',
    account: null,
    folder: { id: 'folder_1', name: 'Renders' },
    error: null,
    uploads: [],
    durable: null,
  })
})

describe('adopt', () => {
  it('completes the connection Google granted during sign-in', async () => {
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().adopt('sign-in-code')

    expect(adoptConnection).toHaveBeenCalledWith('sign-in-code')
    expect(useDriveStore.getState().status).toBe('connected')
    expect(useDriveStore.getState().account?.email).toBe('someone@example.com')
    // So the fallback path on the next load knows there is something to resume.
    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBe('1')
  })

  it('leaves the user signed in when they decline the Drive permissions', async () => {
    adoptConnection.mockRejectedValue(new Error('Google Drive access was only partly granted.'))
    useDriveStore.setState({ status: 'connecting', folder: null })

    await useDriveStore.getState().adopt('sign-in-code')

    // Reported as never having connected — which is true — so Settings offers
    // to ask for the permission on its own rather than claiming a lapsed session.
    expect(useDriveStore.getState().status).toBe('disconnected')
    expect(useDriveStore.getState().error).toMatch(/partly granted/)
    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBeNull()
  })

  it('is not undone by the restore that runs as the editor mounts', async () => {
    // Sign-in claims the connection before the session exists, so the two run
    // concurrently. Without the guard, restore's older answer lands last and
    // shows "Connect Google Drive" to someone who just connected.
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
    useDriveStore.getState().setConnecting(true)

    const adopting = useDriveStore.getState().adopt('sign-in-code')
    await useDriveStore.getState().restore()
    await adopting

    expect(loadConnectionStatus).not.toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('connected')
  })

  it('releases the claim when the sign-in it was made for never landed', () => {
    useDriveStore.getState().setConnecting(true)
    expect(useDriveStore.getState().status).toBe('connecting')

    // Otherwise a failed sign-in leaves Settings spinning, and the next
    // `restore` stands down for a connection that is not coming.
    useDriveStore.getState().setConnecting(false)
    expect(useDriveStore.getState().status).toBe('disconnected')
  })
})

describe('restore', () => {
  it('resumes a connection stored against the account, on a browser that has never seen it', async () => {
    // The whole point of storing it server-side: a machine with an empty local
    // storage still comes back connected rather than showing the button again.
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: true })
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().restore()

    expect(accessToken).toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('connected')
    expect(useDriveStore.getState().account?.email).toBe('someone@example.com')
    expect(useDriveStore.getState().durable).toBe(true)
  })

  it('offers the button when the account has no stored connection', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
    // Even with a folder left over from a previous connection: the account is
    // the authority, and asking Google about someone who has disconnected would
    // be a prompt they did not ask for.
    useDriveStore.setState({ status: 'disconnected' })

    await useDriveStore.getState().restore()

    expect(accessToken).not.toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
  })

  it('leaves a first-time visitor alone when there is nothing to store connections in', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: false, connected: false })
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().restore()

    expect(accessToken).not.toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
  })

  it('still tries a silent renewal for a browser that connected before', async () => {
    // The fallback path, for a deployment with no server-side storage. The flag
    // is what stops "connected but no folder yet" from looking like a first
    // visit on the next load.
    loadConnectionStatus.mockResolvedValue({ durable: false, connected: false })
    window.localStorage.setItem('editor-cat.drive.linked.v1', '1')
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().restore()

    expect(accessToken).toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('connected')
  })

  it('asks for a reconnect rather than an error when consent is needed again', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: true })
    accessToken.mockRejectedValue(new FakeNeedsConsentError('Connect your Google account.'))
    useDriveStore.setState({ status: 'disconnected' })

    await useDriveStore.getState().restore()

    expect(useDriveStore.getState().status).toBe('needs-reconnect')
    // Nothing has gone wrong that the user should be alarmed by.
    expect(useDriveStore.getState().error).toBeNull()
  })

  it('forgets a connection the account no longer has', async () => {
    window.localStorage.setItem('editor-cat.drive.linked.v1', '1')
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
    useDriveStore.setState({ status: 'disconnected' })

    await useDriveStore.getState().restore()

    // Otherwise the stale flag would keep prompting Google on a deployment that
    // later loses its server-side storage.
    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBeNull()
  })
})

describe('connect', () => {
  it('records that this browser has connected, so the next load resumes', async () => {
    isDurableConnection.mockReturnValue(true)
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().connect()

    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBe('1')
    expect(useDriveStore.getState().status).toBe('connected')
    expect(useDriveStore.getState().durable).toBe(true)
  })

  it('says the connection is only for this visit when it cannot be stored', async () => {
    isDurableConnection.mockReturnValue(false)

    await useDriveStore.getState().connect()

    expect(useDriveStore.getState().durable).toBe(false)
  })
})

describe('forget', () => {
  it('clears this browser without revoking the connection the account owns', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })
    useDriveStore.setState({ status: 'connected', account: { email: 'a@b.c', name: 'A' } })

    useDriveStore.getState().forget()

    // Signing back in should resume Drive, so the stored connection stays put —
    // unlike `disconnect`, which is the user asking for it to be gone.
    expect(disconnect).not.toHaveBeenCalled()
    expect(invalidateToken).toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
    expect(useDriveStore.getState().account).toBeNull()
  })

  it('drops the folder, which is an id in the previous account’s Drive', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })
    window.localStorage.setItem('editor-cat.drive.linked.v1', '1')

    useDriveStore.getState().forget()

    // Left behind, the next person to sign in on this browser would have media
    // uploaded into a folder they cannot reach.
    expect(useDriveStore.getState().folder).toBeNull()
    expect(window.localStorage.getItem('editor-cat.drive.folder.v1')).toBeNull()
    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBeNull()
  })
})

describe('disconnect', () => {
  it('clears everything that would resume the connection on the next load', async () => {
    window.localStorage.setItem('editor-cat.drive.linked.v1', '1')
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    await useDriveStore.getState().disconnect()

    expect(disconnect).toHaveBeenCalled()
    expect(window.localStorage.getItem('editor-cat.drive.linked.v1')).toBeNull()
    expect(window.localStorage.getItem('editor-cat.drive.folder.v1')).toBeNull()
    expect(useDriveStore.getState().status).toBe('disconnected')
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
