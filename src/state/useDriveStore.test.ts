import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../lib/types'

const uploadFile = vi.fn()
const update = vi.fn()
const accessToken = vi.fn()
const loadConnectionStatus = vi.fn<() => Promise<{ durable: boolean; connected: boolean }>>()
const isDurableConnection = vi.fn<() => boolean | null>(() => null)
const adoptConnection = vi.fn()
const invalidateToken = vi.fn()

class FakeNeedsConsentError extends Error {}

vi.mock('../lib/google/gis', () => ({
  adoptConnection: (code: string) => adoptConnection(code) as unknown,
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

/** The Auth0 subject the folder is filed under, or null for nobody signed in. */
let subject: string | null = 'google-oauth2|1'

vi.mock('./useAuthStore', () => ({
  isSignedIn: () => subject !== null,
  useAuthStore: {
    getState: () => ({ account: subject ? { id: subject, email: 'someone@example.com' } : null }),
  },
}))

let supabaseConfigured = true

vi.mock('../lib/supabase/client', () => ({
  isSupabaseConfigured: () => supabaseConfigured,
}))

const getDriveFolder = vi.fn<() => Promise<{ id: string; name: string } | null>>()
const saveDriveFolder = vi.fn(async (_folder: { id: string; name: string }) => {})
const clearDriveFolder = vi.fn(async () => {})

vi.mock('../lib/supabase/driveFolder', () => ({
  getDriveFolder: () => getDriveFolder(),
  saveDriveFolder: (folder: { id: string; name: string }) => saveDriveFolder(folder),
  clearDriveFolder: () => clearDriveFolder(),
}))

const FOLDER_KEY = 'editor-cat.drive.folder.v1'

/** What this browser has cached, as whatever version of the app wrote it. */
function cache(folder: { id: string; name: string }, account?: string): void {
  window.localStorage.setItem(
    FOLDER_KEY,
    JSON.stringify({ ...folder, ...(account ? { account } : {}) }),
  )
}

function cached(): unknown {
  const raw = window.localStorage.getItem(FOLDER_KEY)
  return raw === null ? null : JSON.parse(raw)
}

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
  subject = 'google-oauth2|1'
  supabaseConfigured = true
  getDriveFolder.mockResolvedValue(null)
  // Restated rather than left to `clearAllMocks`, which forgets the calls but
  // keeps the implementation — so a test that makes this reject would otherwise
  // hand its failure to every test declared after it.
  accessToken.mockResolvedValue('drive-token')
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

  it('reports no connection when the account has none, folder or not', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
    // A folder left over from a previous account must not be read as a
    // connection: the account is the only authority on that now.
    useDriveStore.setState({ status: 'disconnected' })

    await useDriveStore.getState().restore()

    expect(accessToken).not.toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
  })

  it('does not try Google when the site cannot store connections at all', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: false, connected: false })
    useDriveStore.setState({ status: 'disconnected', folder: null })

    await useDriveStore.getState().restore()

    expect(accessToken).not.toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
  })

  it('flags a revoked grant as needing a reconnect rather than as an error', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: true, connected: true })
    accessToken.mockRejectedValue(new FakeNeedsConsentError('Connect your Google account.'))
    useDriveStore.setState({ status: 'disconnected' })

    await useDriveStore.getState().restore()

    expect(useDriveStore.getState().status).toBe('needs-reconnect')
    // Nothing has gone wrong that the user should be alarmed by.
    expect(useDriveStore.getState().error).toBeNull()
  })

  /**
   * Where the media goes, on a sign-in that is not the first one.
   *
   * The folder used to be a fact about a browser: localStorage and nowhere else,
   * cleared on sign-out because it is an id in one account's Drive. So the
   * answer was thrown away by the act of leaving, and the gate asked "Where
   * should your media go?" on every login. It is the account's now, and this is
   * where a login collects it — before the status moves, because the gate draws
   * the folder step the instant it sees `connected`.
   */
  describe('the folder it comes back with', () => {
    beforeEach(() => {
      loadConnectionStatus.mockResolvedValue({ durable: true, connected: true })
      useDriveStore.setState({ status: 'disconnected', folder: null })
    })

    it('comes from the account, so a returning login is not asked again', async () => {
      // Nothing in this browser: a fresh machine, cleared site data, or simply
      // the sign-out that cleared it on the way past.
      getDriveFolder.mockResolvedValue({ id: 'folder_saved', name: 'Renders' })

      await useDriveStore.getState().restore()

      expect(useDriveStore.getState().folder).toEqual({ id: 'folder_saved', name: 'Renders' })
      // Settled by the time the gate can see the connection, or the folder step
      // draws for a frame in front of someone who already answered it.
      expect(useDriveStore.getState().status).toBe('connected')
    })

    it('prefers the account to a copy this browser is holding', async () => {
      // Changed in Settings on another machine. The account is the authority on
      // the question; this browser is a cache that can be behind.
      cache({ id: 'folder_old', name: 'Old' }, 'google-oauth2|1')
      getDriveFolder.mockResolvedValue({ id: 'folder_new', name: 'New' })

      await useDriveStore.getState().restore()

      expect(useDriveStore.getState().folder).toEqual({ id: 'folder_new', name: 'New' })
      expect(cached()).toMatchObject({ id: 'folder_new', name: 'New' })
    })

    it('adopts a choice made before the account kept one, rather than asking for it again', async () => {
      // Written by a version that had nowhere else to put it. The person is
      // already using that folder; asking would be a question with an answer.
      cache({ id: 'folder_local', name: 'Renders' })
      getDriveFolder.mockResolvedValue(null)

      await useDriveStore.getState().restore()

      expect(useDriveStore.getState().folder).toEqual({ id: 'folder_local', name: 'Renders' })
      expect(saveDriveFolder).toHaveBeenCalledWith({ id: 'folder_local', name: 'Renders' })
    })

    it('will not inherit a folder another account left in this browser', async () => {
      // Only reachable by the Drive it lives in, so opening the editor onto it
      // would mean uploads that fail for a reason nobody could read. Asking is
      // the right answer here.
      cache({ id: 'folder_theirs', name: 'Theirs' }, 'google-oauth2|2')
      getDriveFolder.mockResolvedValue(null)

      await useDriveStore.getState().restore()

      expect(useDriveStore.getState().folder).toBeNull()
      expect(saveDriveFolder).not.toHaveBeenCalled()
    })

    it('falls back to this browser when the account cannot be asked', async () => {
      cache({ id: 'folder_local', name: 'Renders' }, 'google-oauth2|1')
      getDriveFolder.mockRejectedValue(new Error('offline'))

      await useDriveStore.getState().restore()

      // The connection is fine and the answer exists; a table that could not be
      // read this minute is no reason to put the question back on screen.
      expect(useDriveStore.getState().status).toBe('connected')
      expect(useDriveStore.getState().folder).toEqual({ id: 'folder_local', name: 'Renders' })
      // And no write on a guess, which could overwrite a newer choice.
      expect(saveDriveFolder).not.toHaveBeenCalled()
    })

    it('asks nobody about a folder in a build with no account behind it', async () => {
      supabaseConfigured = false
      subject = null
      cache({ id: 'folder_local', name: 'Renders' })

      await useDriveStore.getState().restore()

      expect(getDriveFolder).not.toHaveBeenCalled()
      expect(useDriveStore.getState().folder).toEqual({ id: 'folder_local', name: 'Renders' })
    })
  })
})

describe('forget', () => {
  it('clears this browser without revoking the connection the account owns', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })
    useDriveStore.setState({ status: 'connected', account: { email: 'a@b.c', name: 'A' } })

    useDriveStore.getState().forget()

    // Signing back in should resume Drive, so the connection stored against the
    // account stays put — this only clears what this browser was holding.
    expect(invalidateToken).toHaveBeenCalled()
    expect(useDriveStore.getState().status).toBe('disconnected')
    expect(useDriveStore.getState().account).toBeNull()
  })

  it('drops the folder, which is an id in the previous account’s Drive', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    useDriveStore.getState().forget()

    // Left behind, the next person to sign in on this browser would have media
    // uploaded into a folder they cannot reach.
    expect(useDriveStore.getState().folder).toBeNull()
    expect(cached()).toBeNull()
  })

  it('leaves the account’s folder standing, which is what makes signing back in quiet', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    useDriveStore.getState().forget()

    // Clearing it here is the whole bug: the answer would be gone by the time
    // the same person came back, and the gate would ask for it again.
    expect(clearDriveFolder).not.toHaveBeenCalled()
  })
})

describe('setFolder', () => {
  it('persists the choice so a reload keeps saving to the same place', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    expect(cached()).toMatchObject({ id: 'folder_2', name: 'B-roll' })
  })

  it('records it against the account, which is what outlives this browser', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    expect(saveDriveFolder).toHaveBeenCalledWith({ id: 'folder_2', name: 'B-roll' })
  })

  it('stamps the local copy with whose choice it was', () => {
    // So the next person to sign in on this browser is asked their own question
    // rather than handed a folder in someone else's Drive.
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })

    expect(cached()).toMatchObject({ account: 'google-oauth2|1' })
  })

  it('clears the stored folder when unset', () => {
    useDriveStore.getState().setFolder({ id: 'folder_2', name: 'B-roll' })
    useDriveStore.getState().setFolder(null)

    expect(cached()).toBeNull()
    // Unsetting is a decision, unlike signing out: the account should stop
    // claiming a folder its owner has taken back.
    expect(clearDriveFolder).toHaveBeenCalled()
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
