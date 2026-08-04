/**
 * The Google Drive connection: who is signed in, which folder we write to, and
 * what is currently uploading.
 *
 * The chosen folder is the only thing persisted. Access tokens deliberately
 * stay in memory (see lib/google/gis.ts), so a reload always re-acquires one —
 * silently when Google allows it, and behind a "Reconnect" button when not.
 */
import { create } from 'zustand'
import {
  connect as gisConnect,
  disconnect as gisDisconnect,
  accessToken,
  isDriveConfigured,
  NeedsConsentError,
} from '../lib/google/gis'
import { currentUser, DriveError, uploadFile, type DriveFolder } from '../lib/google/drive'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from './useAssetStore'
import type { Asset } from '../lib/types'

const FOLDER_KEY = 'editor-cat.drive.folder.v1'

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

  /** Attempts a silent sign-in for a returning user. Safe to call on mount. */
  restore: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
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

  restore: async () => {
    if (!isDriveConfigured()) return
    // Nothing to resume for someone who has never picked a folder — asking
    // Google about them on every cold load would be noise.
    if (!get().folder) return

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

  connect: async () => {
    set({ status: 'connecting', error: null })
    try {
      await gisConnect()
      set({ status: 'connected', account: await currentUser() })
    } catch (cause) {
      set({
        status: get().folder ? 'needs-reconnect' : 'disconnected',
        error: toDisplayMessage(cause),
      })
    }
  },

  disconnect: async () => {
    await gisDisconnect()
    persistFolder(null)
    set({ status: 'disconnected', account: null, folder: null, error: null, uploads: [] })
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
