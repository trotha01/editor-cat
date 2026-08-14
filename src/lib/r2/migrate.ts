/**
 * Moving what is already in Drive into our own storage.
 *
 * A one-shot, run once per account, and the reason Drive cannot simply be
 * deleted in the same change that stops writing to it: there are real bytes up
 * there — every generated clip, every recording, every word-shelf take — and
 * they are wanted.
 *
 * It covers both surfaces in one pass because they are one thing underneath. A
 * word-shelf take is a `WordVideo` pointing at an `assetId`, and the asset is
 * what carries the file id; so "every asset row with a Drive id and no R2 key"
 * is the whole of the work, whether it came from a timeline or a word.
 *
 * Two properties it must have, both because somebody will close the tab:
 *
 *  - **Idempotent.** An asset that already has a key is skipped, so running it
 *    twice costs one query and does nothing else.
 *  - **Resumable.** Each asset is finished — uploaded *and* recorded — before
 *    the next one starts. There is no batch to half-commit, so the work already
 *    done survives a refresh, a lost connection, or a closed laptop.
 *
 * Nothing in Drive is deleted. Deleting somebody's files to tidy up is not this
 * app's call, and it is the position the app already takes everywhere else it
 * touches their Drive.
 */
import { listAssets, fromRow, upsertAsset } from '../supabase/assets'
import { downloadFile } from '../google/drive'
import { getBlob, putBlob } from '../db'
import { uploadFiles } from './upload'
import { newId } from '../media'
import { toDisplayMessage } from '../errors'
import type { Asset } from '../types'

export interface MigrationProgress {
  done: number
  total: number
  /** What is being moved right now, for a line the user can read. */
  current?: string
}

export interface MigrationFailure {
  assetId: string
  name: string
  reason: string
}

export interface MigrationSummary {
  moved: number
  /** Already had a key: previous run, or uploaded since the move. */
  skipped: number
  failed: MigrationFailure[]
}

/** Everything still only in Drive. */
export function pendingOf(assets: Asset[]): Asset[] {
  return assets.filter((asset) => Boolean(asset.driveFileId) && !asset.r2Key)
}

/**
 * How much is left to move, asked of the account rather than of this browser.
 *
 * The catalogue in memory is only what this machine has heard about; the
 * account's rows are the whole picture, which is what makes the count honest
 * on a second device.
 */
export async function countPending(): Promise<number> {
  const rows = await listAssets()
  return rows.filter((row) => row.drive_file_id !== null && row.r2_key === null).length
}

export interface MigrateOptions {
  onProgress?: (progress: MigrationProgress) => void
  signal?: AbortSignal
}

/**
 * Moves every asset that is still only in Drive.
 *
 * Bytes come from IndexedDB when this browser happens to have them and from
 * Drive otherwise — the same file either way, and skipping a download that is
 * not needed makes migrating on the machine that made the work much faster.
 */
export async function migrateDriveToR2(options: MigrateOptions = {}): Promise<MigrationSummary> {
  const { onProgress, signal } = options

  // No configuration check here on purpose. Whether there is storage to move
  // into is the server's answer to give — `/api/r2` reports it with a 503
  // naming what it is missing — and the browser cannot see that. An earlier
  // version guessed with `isR2Configured()`, which reads the *public* CDN
  // domain that this path never touches, so a deployment with a perfectly good
  // private bucket refused to migrate into it.
  const rows = await listAssets()
  const all = rows.map((row) => fromRow(row, newId('blob')))
  const pending = pendingOf(all)
  const skipped = all.length - pending.length

  const failed: MigrationFailure[] = []
  let done = 0

  const report = (current?: string) =>
    onProgress?.({ done, total: pending.length, ...(current ? { current } : {}) })

  report()

  // One at a time, deliberately. This is a background chore competing with an
  // editor the user may still be using, and a wide fan-out of Drive downloads
  // is also the thing Drive rate limits first.
  for (const asset of pending) {
    if (signal?.aborted) break
    report(asset.name)

    try {
      // Local bytes if we have them: the machine that made the work does not
      // need to fetch it back from Drive to send it somewhere else.
      let blob = await getBlob(asset.blobKey)
      if (!blob) {
        blob = await downloadFile(asset.driveFileId as string, signal)
        // Kept, since it was worth fetching. A migration that filled the local
        // cache as a side effect is a migration that also made this browser
        // faster.
        await putBlob(asset.blobKey, blob)
      }

      const result = await uploadFiles({
        scope: 'asset',
        files: [{ name: asset.id, blob, contentType: asset.mimeType }],
        ...(signal ? { signal } : {}),
      })

      const key = result.objects[0]?.key
      if (!key) throw new Error('The upload did not report where it went.')

      // Recorded before moving on, which is what makes this resumable: a closed
      // tab loses at most the asset in flight, and a second run skips
      // everything already carrying a key.
      await upsertAsset({ ...asset, r2Key: key }, blob.size)
    } catch (cause) {
      failed.push({ assetId: asset.id, name: asset.name, reason: toDisplayMessage(cause) })
    } finally {
      done += 1
      report()
    }
  }

  return { moved: done - failed.length, skipped, failed }
}
