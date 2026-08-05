/**
 * The Google Drive connection: who is signed in, which folder we write to, and
 * what is currently uploading.
 *
 * What survives a reload depends on how the deployment is set up. Where a
 * connection can be stored server-side, it belongs to the account and is resumed
 * on every load without the user seeing Google at all. Where it cannot, the
 * fallback is the old behaviour: a token that lives in memory for an hour, an
 * attempt to renew it silently on load, and a "Reconnect" button when Google
 * will not renew without UI. See lib/google/gis.ts.
 *
 * Two things are kept in this browser either way — the chosen folder, and the
 * fact that the user has connected before. Neither is a credential; both exist
 * so a returning visit knows there is something to resume rather than asking
 * Google about someone who has never used the feature.
 */
import { create } from 'zustand'
import {
  adoptConnection,
  connect as gisConnect,
  disconnect as gisDisconnect,
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
const LINKED_KEY = 'editor-cat.drive.linked.v1'

/**
 * `needs-reconnect` is distinct from `disconnected`: the user has chosen a
 * folder before, so the UI should offer to resume rather than start over.
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
   * Whether this connection outlives the tab. Null until the first status check
   * answers; only Settings reads it, to say which of the two it is.
   */
  durable: boolean | null

  /** Resumes a previous connection without prompting. Safe to call on mount. */
  restore: () => Promise<void>
  /**
   * Claims the connection while sign-in is still in flight, so the `restore`
   * that runs as the editor mounts does not race it to a stale answer. Released
   * with `false` if the sign-in it was claimed for never happened.
   */
  setConnecting: (pending: boolean) => void
  /** Completes a connection authorised during sign-in. */
  adopt: (code: string) => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
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

/**
 * Remembers that this browser has connected before.
 *
 * Only consulted on deployments with no server-side connection to ask about.
 * Without it, someone who connected but has not yet chosen a folder would be
 * shown "Connect Google Drive" on their next visit, as if they never had.
 */
function loadLinked(): boolean {
  try {
    return window.localStorage.getItem(LINKED_KEY) === '1'
  } catch {
    return false
  }
}

function persistLinked(linked: boolean): void {
  try {
    if (linked) window.localStorage.setItem(LINKED_KEY, '1')
    else window.localStorage.removeItem(LINKED_KEY)
  } catch {
    // As above: storage can be refused, and this is only a hint.
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
    // Signing in authorises Drive too, so by the time the editor mounts the
    // connection may already be in hand or on its way. Asking the server again
    // would at best duplicate work and at worst overwrite a fresher answer with
    // a stale one.
    if (get().status === 'connected' || get().status === 'connecting') return

    const { durable, connected } = await loadConnectionStatus()
    set({ durable })

    if (durable) {
      // The account itself says whether there is anything to resume, so a
      // browser that has never seen this user still picks the connection up.
      if (!connected) {
        persistLinked(false)
        set({ status: 'disconnected' })
        return
      }
      persistLinked(true)
    } else if (!get().folder && !loadLinked()) {
      // No stored connection to consult and no sign this browser ever had one.
      // Asking Google about a first-time visitor on every cold load is noise.
      return
    }

    set({ status: 'connecting', error: null })
    try {
      await accessToken()
      set({ status: 'connected', account: await currentUser() })
    } catch (cause) {
      // A silent attempt failing is the normal path for an expired session, so
      // it is not surfaced as an error — just as a reconnect affordance.
      set({
        status: 'needs-reconnect',
        ...(cause instanceof NeedsConsentError ? {} : { error: toDisplayMessage(cause) }),
      })
    }
  },

  setConnecting: (pending) => set({ status: pending ? 'connecting' : 'disconnected', error: null }),

  adopt: async (code) => {
    set({ status: 'connecting', error: null })
    try {
      await adoptConnection(code)
      persistLinked(true)
      set({ status: 'connected', durable: isDurableConnection(), account: await currentUser() })
    } catch (cause) {
      // Signing in worked; only the Drive half did not. Reported as never having
      // connected rather than as a lapsed session, because that is what it is —
      // and Settings then offers to ask for the permission on its own.
      persistLinked(false)
      set({ status: 'disconnected', account: null, error: toDisplayMessage(cause) })
    }
  },

  connect: async () => {
    set({ status: 'connecting', error: null })
    try {
      await gisConnect()
      persistLinked(true)
      // Connecting is what settles this: the flow can discover mid-way that the
      // site cannot store a connection after all, and Settings should say so.
      set({ status: 'connected', durable: isDurableConnection(), account: await currentUser() })
    } catch (cause) {
      set({
        status: get().folder || loadLinked() ? 'needs-reconnect' : 'disconnected',
        error: toDisplayMessage(cause),
      })
    }
  },

  disconnect: async () => {
    await gisDisconnect()
    persistFolder(null)
    persistLinked(false)
    set({ status: 'disconnected', account: null, folder: null, error: null, uploads: [] })
  },

  forget: () => {
    // The access token has to go, or the next account to sign in on this
    // browser inherits the last one's Drive for as long as it stays valid.
    invalidateToken()
    // The folder goes with it for the same reason: it is an id in someone
    // else's Drive, and uploading into it would fail in a way nobody could read.
    persistFolder(null)
    persistLinked(false)
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
