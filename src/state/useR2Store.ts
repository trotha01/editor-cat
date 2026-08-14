/**
 * Backing generated media up to our own storage.
 *
 * The counterpart of useDriveStore, and eventually its replacement. It attaches
 * to the same single ingest hook (`setIngestListener` in lib/media.ts), so
 * generated images, rendered clips, recordings, manual uploads and word-shelf
 * takes all reach durable storage by one route that none of them knows about.
 *
 * **The idempotence guard is the load-bearing line here.** An asset that
 * already carries an `r2Key` is never uploaded again. Drive's version of this
 * (`if (asset.driveFileId) return`) is one line in useDriveStore, and losing it
 * would not have crashed anything — it would have re-uploaded every asset on
 * every ingest, which on somebody else's bill is a bug that gets noticed a
 * month later by an invoice.
 *
 * Failure is reported rather than swallowed, which is a change from how Drive
 * behaved. It could afford to be quiet: the bytes were also in IndexedDB *and*
 * in the user's own Drive, so a failed upload cost a backup and nothing else.
 * With Drive gone, this is the only other copy, so a silent failure plus a
 * cleared site data is lost work. Editing still never waits on it — that is the
 * "local first, cloud second" rule the sync scheduler is built around — but the
 * state is legible and the upload is retried.
 */
import { create } from 'zustand'
import { StorageUnconfiguredError, uploadFiles } from '../lib/r2/upload'
import { recordAsset } from '../lib/sync/assetSync'
import { useAssetStore } from './useAssetStore'
import { isSignedIn } from './useAuthStore'
import type { Asset } from '../lib/types'

export interface UploadJob {
  assetId: string
  name: string
  /** Which attempt this is. Shown once it is more than one. */
  attempt: number
  state: 'uploading' | 'failed'
  error?: string
}

interface R2State {
  uploads: UploadJob[]
  /** Assets whose upload gave up, kept so the UI can offer to try again. */
  failed: UploadJob[]
  /**
   * Whether this deployment has storage behind it.
   *
   * Starts true and is turned off only by `/api/r2` saying so, because nothing
   * on this side can know: it is a fact about the server's environment. An
   * earlier version guessed at it with `isR2Configured()`, which reads
   * `VITE_R2_PUBLIC_BASE` — but that is the *public* CDN domain, and this path
   * never dereferences it. Assets go to the private bucket by presigned URL
   * against the S3 endpoint, so gating them on the feed's hostname meant a
   * deployment could have working storage and refuse to use it.
   */
  storageAvailable: boolean
  uploadAsset: (asset: Asset, blob: Blob) => void
  retryFailed: () => void
  clearFailed: (assetId: string) => void
}

/**
 * Three goes, backing off.
 *
 * Enough to ride out a dropped connection or a rate limit without turning a
 * genuinely refused upload — an expired session, a file over the cap — into a
 * long wait before the user is told.
 */
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [1000, 4000]

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The blob for a retry, since the caller's reference is long gone. */
const pending = new Map<string, Blob>()

export const useR2Store = create<R2State>((set, get) => ({
  uploads: [],
  failed: [],
  storageAvailable: true,

  uploadAsset: (asset, blob) => {
    // Already ours: this asset has been backed up, or was restored from storage
    // in the first place. Without this, every ingest re-uploads everything.
    if (asset.r2Key) return
    if (!get().storageAvailable || !isSignedIn()) return

    pending.set(asset.id, blob)

    const patch = (change: Partial<UploadJob>) =>
      set((state) => ({
        uploads: state.uploads.map((entry) =>
          entry.assetId === asset.id ? { ...entry, ...change } : entry,
        ),
      }))

    set((state) => ({
      uploads: [
        ...state.uploads.filter((entry) => entry.assetId !== asset.id),
        { assetId: asset.id, name: asset.name, attempt: 1, state: 'uploading' },
      ],
      failed: state.failed.filter((entry) => entry.assetId !== asset.id),
    }))

    void (async () => {
      let lastError: unknown

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (attempt > 1) {
          patch({ attempt, state: 'uploading' })
          await wait(BACKOFF_MS[attempt - 2] ?? 4000)
        }

        try {
          const result = await uploadFiles({
            scope: 'asset',
            files: [{ name: asset.id, blob, contentType: asset.mimeType }],
          })

          const key = result.objects[0]?.key
          if (!key) throw new Error('The upload did not report where it went.')

          // Recording the key is what makes the backup idempotent — an asset
          // carrying one is never uploaded again. The dependency only points
          // this way: the asset store knows nothing about R2.
          await useAssetStore.getState().update(asset.id, { r2Key: key })

          // Second catalogue write. The first, at ingest, had no key to record;
          // this is the one that makes the bytes recoverable on another device.
          void recordAsset({ ...asset, r2Key: key }, blob.size)

          pending.delete(asset.id)
          set((state) => ({ uploads: state.uploads.filter((e) => e.assetId !== asset.id) }))
          return
        } catch (cause) {
          if (cause instanceof StorageUnconfiguredError) {
            // Not this upload's failure, and every later one would be told the
            // same thing. Going quiet is the honest answer: a "not backed up"
            // card here would be about the deployment rather than about
            // anything the person looking at it did, or could fix.
            pending.delete(asset.id)
            set((state) => ({
              storageAvailable: false,
              uploads: state.uploads.filter((entry) => entry.assetId !== asset.id),
            }))
            return
          }
          lastError = cause
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError)
      const job: UploadJob = {
        assetId: asset.id,
        name: asset.name,
        attempt: MAX_ATTEMPTS,
        state: 'failed',
        error: message,
      }
      set((state) => ({
        uploads: state.uploads.filter((entry) => entry.assetId !== asset.id),
        failed: [...state.failed.filter((entry) => entry.assetId !== asset.id), job],
      }))
    })()
  },

  retryFailed: () => {
    const { failed } = get()
    const assets = useAssetStore.getState().assets
    set({ failed: [] })

    for (const job of failed) {
      const asset = assets.find((entry) => entry.id === job.assetId)
      const blob = pending.get(job.assetId)
      // An asset whose bytes this browser no longer holds cannot be retried
      // from here; it is dropped rather than left claiming it will be.
      if (asset && blob) get().uploadAsset(asset, blob)
    }
  },

  clearFailed: (assetId) => {
    pending.delete(assetId)
    set((state) => ({ failed: state.failed.filter((entry) => entry.assetId !== assetId) }))
  },
}))
