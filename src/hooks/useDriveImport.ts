/**
 * Brings media from the user's Drive into the local library.
 *
 * The browsing is Google's, not ours: `pickMedia` opens the Google Picker inside
 * the chosen folder, and whatever comes back is granted to this app per-file.
 * That is what lets the whole editor run on `drive.file` instead of the
 * restricted `drive.readonly` it would take to list someone's folder ourselves.
 *
 * Import copies the bytes into IndexedDB rather than streaming from Drive on
 * demand. Drive has no URL that both carries our token and serves range
 * requests, so a `<video>` pointed at it could not seek — and export needs the
 * bytes locally anyway (see lib/media.ts).
 */
import { useState } from 'react'
import { downloadFile, type DriveFile } from '../lib/google/drive'
import { pickMedia } from '../lib/google/picker'
import { ingestBlob } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useDriveStore } from '../state/useDriveStore'

export interface ImportState {
  /** Files copied so far, out of how many. Null when nothing is running. */
  progress: { done: number; total: number } | null
  error: string | null
}

/**
 * Runs the pick-then-download flow.
 *
 * A hook rather than a dialog because there is no longer a dialog to render —
 * the Picker is Google's own window, so all that is left on this side is the
 * button that opens it and the progress it reports.
 */
export function useDriveImport(): ImportState & { start: () => Promise<void> } {
  const folder = useDriveStore((state) => state.folder)
  const assets = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)

  const [progress, setProgress] = useState<ImportState['progress']>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!folder || progress) return
    setError(null)

    let picked: DriveFile[]
    try {
      picked = await pickMedia(folder.id)
    } catch (cause) {
      setError(toDisplayMessage(cause))
      return
    }

    // Anything already in the library is skipped rather than refused: the user
    // picked from their whole Drive and cannot be expected to remember what they
    // imported last time.
    const known = new Set(assets.map((asset) => asset.driveFileId).filter(Boolean))
    const targets = picked.filter((file) => !known.has(file.id))
    if (targets.length === 0) return

    setProgress({ done: 0, total: targets.length })
    const failures: string[] = []

    for (const [index, file] of targets.entries()) {
      try {
        const blob = await downloadFile(file.id)
        // `driveFileId` marks this as already-in-Drive, which is what stops the
        // upload hook from immediately sending it straight back.
        const asset = await ingestBlob(blob, {
          kind: file.kind,
          name: file.name,
          driveFileId: file.id,
        })
        addAsset(asset)
      } catch (cause) {
        failures.push(`${file.name}: ${toDisplayMessage(cause)}`)
      }
      setProgress({ done: index + 1, total: targets.length })
    }

    setProgress(null)
    if (failures.length > 0) {
      setError(`${failures.length} of ${targets.length} could not be imported. ${failures[0]}`)
    }
  }

  return { progress, error, start }
}
