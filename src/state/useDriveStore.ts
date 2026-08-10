/**
 * The Google Drive connection: whose it is, which folder we write under, and
 * what is currently uploading.
 *
 * Granting it is `connect`, and it is a screen of its own: Auth0 files a login's
 * provider tokens against the user's identity, which is not the store Token
 * Vault reads, so the folder permission has to be asked for as a connected
 * account rather than ridden in on the sign-in. Auth0 keeps what comes back —
 * which is why `restore` asks our own server what this account has rather than
 * asking Google, and a browser that has never seen them still picks it up.
 *
 * The chosen folder is the one thing kept locally. It is not a credential; it is
 * a preference about where new media goes. It is a *parent*: each project has a
 * folder of its own inside it and uploads go there, so the folder chosen here
 * says which corner of someone's Drive this app writes to rather than being the
 * single place everything lands. Which is why the stored value did not need a
 * new key when that changed — a folder that used to be the target is exactly the
 * right parent, and the media already in it stays where it is.
 */
import { create } from 'zustand'
import {
  accessToken,
  invalidateToken,
  isDriveConfigured,
  loadConnectionStatus,
  NeedsConsentError,
} from '../lib/google/gis'
import { currentUser, DriveError, uploadFile, type DriveFolder } from '../lib/google/drive'
import { connectDrive } from '../lib/auth0/client'
import { useAuthStore } from './useAuthStore'
import { toDisplayMessage } from '../lib/errors'
import { recordAsset } from '../lib/sync/assetSync'
import { useAssetStore } from './useAssetStore'
import { useProjectStore } from './useProjectStore'
import type { Asset } from '../lib/types'

const FOLDER_KEY = 'editor-cat.drive.folder.v1'

/**
 * `needs-reconnect` is distinct from `disconnected`: the connection existed and
 * stopped working, which is worth telling someone mid-session. Both are answered
 * the same way — signing in again — but only one is a surprise.
 */
export type DriveStatus =
  'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'needs-reconnect'

export interface UploadJob {
  assetId: string
  name: string
  /** 0 to 1. */
  progress: number
  error?: string
}

interface DriveState {
  status: DriveStatus
  account: { email: string; name: string } | null
  /**
   * The folder chosen at first run, and the parent of every project folder.
   * Media only lands in it directly for a project that has none of its own.
   */
  folder: DriveFolder | null
  error: string | null
  uploads: UploadJob[]
  /**
   * Whether this deployment can store connections at all. Null until the first
   * status check answers. False means an operator has not finished setting the
   * site up, and the gate says so rather than offering a sign-in that cannot work.
   */
  durable: boolean | null

  /** Resumes the account's connection without prompting. Safe to call on mount. */
  restore: () => Promise<void>
  /**
   * Asks Google for the folder permission. Leaves the page.
   *
   * A step of its own, because a login's provider tokens land somewhere Token
   * Vault cannot read — see lib/auth0/client.ts. The account stays signed in
   * throughout: what is missing is a permission, not a session.
   */
  connect: () => void
  /**
   * Drops this browser's Drive state on sign-out, leaving the grant itself
   * alone — it belongs to the account, and signing back in resumes it.
   */
  forget: () => void
  setFolder: (folder: DriveFolder | null) => void
  clearError: () => void

  /** Fire-and-forget upload of a freshly ingested asset. */
  uploadAsset: (asset: Asset, blob: Blob) => void
}

/** Whether a failure means "sign in again" rather than "that one went wrong". */
function isExpiredSession(cause: unknown): boolean {
  if (cause instanceof NeedsConsentError) return true
  return cause instanceof DriveError && cause.status === 401
}

function loadFolder(): DriveFolder | null {
  try {
    const raw = window.localStorage.getItem(FOLDER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DriveFolder>
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null
    return { id: parsed.id, name: parsed.name }
  } catch {
    return null
  }
}

function persistFolder(folder: DriveFolder | null): void {
  try {
    if (folder) window.localStorage.setItem(FOLDER_KEY, JSON.stringify(folder))
    else window.localStorage.removeItem(FOLDER_KEY)
  } catch {
    // Private browsing can refuse storage. The folder still works this session.
  }
}

export const useDriveStore = create<DriveState>((set, get) => ({
  status: isDriveConfigured() ? 'disconnected' : 'unconfigured',
  account: null,
  folder: loadFolder(),
  error: null,
  uploads: [],
  durable: null,

  restore: async () => {
    if (!isDriveConfigured()) return
    // A connection may already be in hand, or on its way from the consent the
    // user is in the middle of giving. Asking the server again would at best
    // duplicate work and at worst overwrite a fresher answer with a stale one.
    if (get().status === 'connected' || get().status === 'connecting') return

    const { durable, connected } = await loadConnectionStatus()
    set({ durable })

    // The account is the only authority: it says whether there is anything to
    // resume, so a browser that has never seen this user still picks the
    // connection up, and one that has seen them cannot claim a connection the
    // account no longer holds.
    if (!durable || !connected) {
      set({ status: 'disconnected' })
      return
    }

    set({ status: 'connecting', error: null })
    try {
      await accessToken()
      set({ status: 'connected', account: await currentUser() })
    } catch (cause) {
      // A stored connection that has stopped working is the normal path for a
      // revoked grant, so it is not surfaced as an error — just as a prompt to
      // sign in again.
      set({
        status: 'needs-reconnect',
        ...(cause instanceof NeedsConsentError ? {} : { error: toDisplayMessage(cause) }),
      })
    }
  },

  connect: () => {
    set({ status: 'connecting', error: null })
    // Navigates away, so nothing after it runs — but the navigation happens
    // inside the SDK after a round trip to Auth0, and a refusal there would
    // otherwise leave the gate spinning at `connecting` with nothing to show.
    void connectDrive(useAuthStore.getState().account?.email).catch((cause: unknown) => {
      set({ status: 'disconnected', error: toDisplayMessage(cause) })
    })
  },

  forget: () => {
    // The access token has to go, or the next account to sign in on this
    // browser inherits the last one's Drive for as long as it stays valid.
    invalidateToken()
    // The folder goes with it for the same reason: it is an id in someone
    // else's Drive, and uploading into it would fail in a way nobody could read.
    //
    // The project folders inside it need no clearing here. They are recorded
    // against the projects, which belong to the account and are re-fetched for
    // whoever signs in next, and with no parent folder nothing uploads anyway.
    persistFolder(null)
    set({
      status: isDriveConfigured() ? 'disconnected' : 'unconfigured',
      account: null,
      folder: null,
      error: null,
      uploads: [],
      durable: null,
    })
  },

  // Changing the folder moves where *new* projects put their folders, and
  // nothing else. A project that already has one keeps it: its media is in
  // there, and splitting one project across two corners of a Drive to honour a
  // preference set afterwards is worse than leaving it whole.
  setFolder: (folder) => {
    persistFolder(folder)
    set({ folder })
  },

  clearError: () => set({ error: null }),

  uploadAsset: (asset, blob) => {
    const { status, folder } = get()
    // Already in Drive: this asset was imported from there in the first place.
    if (asset.driveFileId) return
    if (status !== 'connected' || !folder) return

    // The open project's own folder is the target; the chosen one is its parent.
    // A project with none — made before projects had folders, or created while
    // Drive could not make one — falls back to the parent itself, which is where
    // media went before this and where that project's earlier uploads already
    // are. The dependency points one way, as it does to the asset store: the
    // project knows nothing about Drive.
    const parentId = useProjectStore.getState().project.driveFolderId ?? folder.id

    const job: UploadJob = { assetId: asset.id, name: asset.name, progress: 0 }
    set((state) => ({ uploads: [...state.uploads, job] }))

    const patch = (change: Partial<UploadJob>) =>
      set((state) => ({
        uploads: state.uploads.map((entry) =>
          entry.assetId === asset.id ? { ...entry, ...change } : entry,
        ),
      }))

    void (async () => {
      try {
        const file = await uploadFile(blob, {
          name: asset.name,
          parentId,
          onProgress: (progress) => patch({ progress }),
        })

        // Recording the id is what makes the backup idempotent: an asset that
        // carries one is never uploaded again. The dependency only points this
        // way — the asset store knows nothing about Drive.
        await useAssetStore.getState().update(asset.id, { driveFileId: file.id })

        // Second catalogue write. The first one, at ingest, had no Drive id to
        // record — and that id is the only thing that makes these bytes
        // recoverable on another machine.
        void recordAsset({ ...asset, driveFileId: file.id }, blob.size)

        set((state) => ({
          uploads: state.uploads.filter((entry) => entry.assetId !== asset.id),
        }))
      } catch (cause) {
        // The bytes are still in IndexedDB, so a failed upload costs the user
        // nothing but the backup. Leave the job visible with its reason.
        patch({ error: toDisplayMessage(cause) })

        // An expired session will fail every later upload the same way, so it
        // is worth promoting to the connection state — otherwise Settings goes
        // on claiming everything is connected while nothing is being saved.
        if (isExpiredSession(cause) && get().status === 'connected') {
          set({ status: 'needs-reconnect' })
        }
      }
    })()
  },
}))

/** Drops a finished-with upload row from the list. */
export function dismissUpload(assetId: string): void {
  useDriveStore.setState((state) => ({
    uploads: state.uploads.filter((entry) => entry.assetId !== assetId),
  }))
}
