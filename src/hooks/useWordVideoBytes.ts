/**
 * Fetching the takes of the word you are looking at.
 *
 * A shelf read out of Drive arrives as names: the word knows its videos and the
 * catalogue knows their Drive ids, and none of the bytes are here. Downloading
 * all of them on sight would mean a second machine pulling every take of every
 * word before it could show anything, so they come down a word at a time — the
 * one that is open, which is the one about to be watched.
 *
 * The same rule the editor hydrates a project by, at the scale this page works
 * at: metadata first so the run is on screen and can be re-ordered, bytes second.
 */
import { useEffect, useState } from 'react'
import { getBlob, putBlob } from '../lib/db'
import { downloadFile } from '../lib/google/drive'
import { downloadAsset } from '../lib/r2/download'
import { mapLimited } from '../lib/concurrency'
import { probeMedia } from '../lib/media'
import { useAssetStore } from '../state/useAssetStore'
import type { Asset } from '../lib/types'

/** How many takes come down at once. Video files, so not many. */
const DOWNLOAD_CONCURRENCY = 2

/**
 * Downloads whatever of `assets` this browser does not hold, and reports which
 * of them are still on their way.
 *
 * Keyed on the ids rather than the array: the catalogue changes identity every
 * time one of these lands, and re-running on that would be a loop.
 */
export function useWordVideoBytes(assets: readonly Asset[]): { fetching: Set<string> } {
  const [fetching, setFetching] = useState<Set<string>>(() => new Set())
  const key = assets.map((asset) => asset.id).join(',')

  useEffect(() => {
    let cancelled = false

    const mark = (id: string, running: boolean) =>
      setFetching((current) => {
        if (current.has(id) === running) return current
        const next = new Set(current)
        if (running) next.add(id)
        else next.delete(id)
        return next
      })

    void (async () => {
      // Read from the store rather than closing over the array, which is not in
      // the dependencies — see `key`.
      const catalogue = useAssetStore.getState().assets
      const wanted = key ? key.split(',') : []
      const missing: { asset: Asset; r2Key?: string; driveFileId?: string }[] = []

      for (const id of wanted) {
        const asset = catalogue.find((entry) => entry.id === id)
        // Our own storage first, Drive only for takes that predate the move.
        // R2 is faster and needs no Drive connection, which is what lets a
        // second device fill a word in with no Google grant at all.
        if (!asset?.r2Key && !asset?.driveFileId) continue
        if (await getBlob(asset.blobKey)) continue
        missing.push({
          asset,
          ...(asset.r2Key ? { r2Key: asset.r2Key } : {}),
          ...(asset.driveFileId ? { driveFileId: asset.driveFileId } : {}),
        })
      }
      if (cancelled || missing.length === 0) return

      await mapLimited(missing, DOWNLOAD_CONCURRENCY, async ({ asset, r2Key, driveFileId }) => {
        mark(asset.id, true)
        try {
          const blob = r2Key
            ? await downloadAsset(r2Key)
            : await downloadFile(driveFileId as string)
          if (cancelled) return
          await putBlob(asset.blobKey, blob)

          // Catalogued from a Drive listing, which knows a file's name and not
          // how long it is — so the row said "video" and the run's running time
          // counted it as nothing. The bytes are here now, and the browser can
          // be asked. It also replaces the asset, which is what makes everything
          // that asked for its URL and was told there was none ask again.
          await useAssetStore
            .getState()
            .update(asset.id, await probeMedia(blob, 'video').catch(() => ({})))
        } catch {
          // The row says the file is not on this machine, which is true. A
          // second visit to the word tries again.
        } finally {
          mark(asset.id, false)
        }
      })
    })()

    return () => {
      cancelled = true
    }
  }, [key])

  return { fetching }
}
