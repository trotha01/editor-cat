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
import { getBlob, listAssets as listLocalAssets, putAsset, putBlob } from '../db'
import { uploadFiles } from './upload'
import { useAssetStore } from '../../state/useAssetStore'
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
  /**
   * Records this browser was told about, for files the account had already
   * moved. See `recordKey` — a run before that existed left every machine in
   * this state.
   */
  reconciled: number
  failed: MigrationFailure[]
}

/**
 * Records a key everywhere this browser will later look for it.
 *
 * Three places have to agree, and the first version of this wrote one:
 *
 *  - the **account's row**, which is what a *second* machine reads when it
 *    opens the project and has never heard of the asset;
 *  - this browser's **IndexedDB record**, which is what `useWordVideoBytes`
 *    and `hydrateProject` read for an asset it *has* heard of;
 *  - the **catalogue in memory**, which is what is on screen right now.
 *
 * Writing only the row is why a migration could report success and leave every
 * video dark. The row said the bytes were in storage; nothing on this machine
 * knew, so `useWordVideoBytes` skipped each take at `!asset?.r2Key` and
 * `planFor` called it 'missing'. Neither is a failure that shows up as one —
 * a take just reads as not being on this machine, which is what it said before
 * the migration too.
 *
 * `adopt` rather than `update`, because `update` returns early for an asset the
 * catalogue has never held, and `load` folds in only ids it does not already
 * have — so neither one alone refreshes a record that is present but stale.
 */
export async function recordKey(asset: Asset, r2Key: string, byteSize?: number): Promise<void> {
  const next: Asset = { ...asset, r2Key }
  await upsertAsset(next, byteSize)
  await putAsset(next)
  useAssetStore.getState().adopt(next)
}

/** Everything still only in Drive. */
export function pendingOf(assets: Asset[]): Asset[] {
  return assets.filter((asset) => Boolean(asset.driveFileId) && !asset.r2Key)
}

/**
 * Whether the database is in a state where anything can be moved.
 *
 * Three answers rather than a boolean, because the two failures need opposite
 * responses: one is a migration that has not been run, and the other is one
 * that has been run too early.
 */
export type SchemaState =
  /** Both columns present. Normal. */
  | 'ready'
  /** 0010 has not been run, so there is nowhere to record a move. */
  | 'missing-r2-key'
  /** 0011 has been run, so nothing can be found in Drive any more. */
  | 'drive-id-dropped'

export interface PendingCount {
  /** Assets whose bytes are still only in Drive. */
  pending: number
  /**
   * Assets the account has already moved that this browser's own record has
   * not caught up with.
   *
   * Counted separately because it is not a Drive job at all — no download, no
   * upload, nothing to consent to. It is this machine being out of step with
   * the account, which is the state a migration run before `recordKey` existed
   * leaves behind, and it presents identically to the files never having moved.
   */
  stale: number
  schema: SchemaState
}

/**
 * How much is left to move, asked of the account rather than of this browser.
 *
 * The catalogue in memory is only what this machine has heard about; the
 * account's rows are the whole picture, which is what makes the count honest
 * on a second device.
 *
 * **`listAssets` selects `*`,** so a column that has not been added yet comes
 * back *absent* rather than null — and `undefined === null` is false. An
 * earlier version compared against null directly, which meant a database
 * without 0010 counted zero pending, and the panel that would have said so
 * hid itself instead. Both columns are therefore checked for existence before
 * anything is counted, and the count itself matches `pendingOf` exactly:
 * whatever is truthy, rather than whatever is not literally null.
 */
export async function countPending(): Promise<PendingCount> {
  const rows = await listAssets()
  const sample = rows[0]

  if (sample && !('r2_key' in sample)) {
    // Still worth a number: it is how many files are waiting on that migration.
    return {
      pending: rows.filter((row) => Boolean(row.drive_file_id)).length,
      stale: 0,
      schema: 'missing-r2-key',
    }
  }

  if (sample && !('drive_file_id' in sample)) {
    return { pending: 0, stale: 0, schema: 'drive-id-dropped' }
  }

  // The second half of the question, and the one that has to be asked of this
  // browser: an asset the account says is in storage, whose local record does
  // not say so, is one whose video will not load here however many times the
  // files are moved.
  const local = new Map((await listLocalAssets()).map((asset) => [asset.id, asset]))

  return {
    pending: rows.filter((row) => Boolean(row.drive_file_id) && !row.r2_key).length,
    stale: rows.filter((row) => {
      if (!row.r2_key) return false
      // Only records this browser actually holds. One it has never heard of is
      // not stale — it is simply absent, and `hydrateProject` fetches those
      // fresh from the account, key and all.
      const known = local.get(row.id)
      return known !== undefined && known.r2Key !== row.r2_key
    }).length,
    schema: 'ready',
  }
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

  // Built against this browser's own records, not from the row alone. The
  // account's table has no `blob_key` — it is per machine — so `fromRow` has to
  // be given one, and an earlier version minted a fresh id for every asset.
  // That had two consequences, both silent: `getBlob` looked under a key
  // nothing was ever filed against, so the local-bytes shortcut never once
  // fired and every file came back down from Drive; and `putBlob` then stored
  // what it had fetched under that same unreferenced key, so the bytes landed
  // in IndexedDB where nothing would ever look for them.
  const local = new Map((await listLocalAssets()).map((asset) => [asset.id, asset]))
  const all = rows.map((row) => fromRow(row, local.get(row.id)?.blobKey ?? newId('blob')))

  // Before moving anything: tell this browser about keys the account already
  // has. Nothing is downloaded or uploaded here — these files moved on some
  // earlier run, and all that is wrong is that the record on this machine
  // never heard about it, which is enough on its own to leave every video dark.
  let reconciled = 0
  for (const asset of all) {
    const known = local.get(asset.id)
    if (!asset.r2Key || !known || known.r2Key === asset.r2Key) continue
    await recordKey(known, asset.r2Key)
    reconciled += 1
  }

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
      // everything already carrying a key. Recorded in all three places, which
      // is what makes the file actually play afterwards — see `recordKey`.
      await recordKey(asset, key, blob.size)
    } catch (cause) {
      failed.push({ assetId: asset.id, name: asset.name, reason: toDisplayMessage(cause) })
    } finally {
      done += 1
      report()
    }
  }

  return { moved: done - failed.length, skipped, reconciled, failed }
}
