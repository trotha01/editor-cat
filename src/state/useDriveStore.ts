/**
 * The Google Drive connection: whose it is, which folder we write to, and what
 * is currently uploading.
 *
 * There is nothing here that grants it. Drive is authorised at the sign-in
 * screen, in the same consent as identity, and the connection is stored against
 * the account — so `restore` asks the server what this user has rather than
 * asking Google, and a browser that has never seen them still picks it up.
 *
 * The chosen folder is the one thing kept locally. It is not a credential; it is
 * a preference about where new media goes.
 */
import { create } from 'zustand'
import {
  adoptConnection,
  accessToken,
  invalidateToken,
  isDriveConfigured,
  isDurableConnection,
  loadConnectionStatus,
  NeedsConsentError,
} from '../lib/google/gis'
import { currentUser, DriveError, uploadFile, type DriveFolder } from '../lib/google/drive'
import { toDisplayMessage } from '../lib/errors'
import { recordAsset } from '../lib/sync/assetSync'
import { useAssetStore } from './useAssetStore'
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
  /** Completes a connection the user has just authorised at Google. */
  adopt: (code: string) => Promise<void>
  /**
   * Drops this browser's Drive state on sign-out, leaving the stored connection
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

  adopt: async (code) => {
    set({ status: 'connecting', error: null })
    try {
      await adoptConnection(code)
      set({ status: 'connected', durable: isDurableConnection(), account: await currentUser() })
    } catch (cause) {
      // Signing in worked; only the Drive half did not — someone unticked it on
      // Google's own screen. Reported as never having connected, because that is
      // what it is, and the gate asks again rather than letting them in without
      // anywhere to put their media.
      set({ status: 'disconnected', account: null, error: toDisplayMessage(cause) })
    }
  },

  forget: () => {
    // The access token has to go, or the next account to sign in on this
    // browser inherits the last one's Drive for as long as it stays valid.
    invalidateToken()
    // The folder goes with it for the same reason: it is an id in someone
    // else's Drive, and uploading into it would fail in a way nobody could read.
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
          parentId: folder.id,
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
