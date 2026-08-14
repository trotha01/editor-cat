/**
 * Refilling a machine that has the timeline but not the media.
 *
 * Opening a project on a second device gives you a document full of asset ids
 * and an empty IndexedDB. The metadata rows say what those assets are — enough
 * to lay the timeline out immediately — and their `r2_key` (or, for anything
 * that predates the move, their `drive_file_id`) says where the bytes live.
 *
 * Metadata is restored first and bytes second, on purpose: the editor is
 * usable, scrubbable and re-orderable while the downloads are still running.
 */
import { getAssets, fromRow } from '../supabase/assets'
import { downloadFile } from '../google/drive'
import { downloadAsset } from '../r2/download'
import { getBlob, putAsset, putBlob } from '../db'
import { mapLimited } from '../concurrency'
import { libraryAssetIdsOf, referencedAssetIds } from '../library'
import { newId } from '../media'
import { toDisplayMessage } from '../errors'
import type { Asset, Project } from '../types'

/** What has to happen for one asset before it can play. */
export type HydrationAction =
  /** Bytes are already in this browser. */
  | 'ready'
  /** Bytes must come down from our own storage. */
  | 'r2'
  /** Bytes must come down from Drive. */
  | 'download'
  /** Nothing to fetch: never backed up anywhere this browser can reach. */
  | 'missing'

/**
 * Where to get one asset's bytes from, in the order worth trying.
 *
 * The local blob first, because it is free and instant — an asset already in
 * IndexedDB is not worth a round trip to anywhere. Then R2, which is faster
 * than Drive and, more importantly, needs no Drive connection at all: a second
 * device can fill a project in without the user ever having granted Drive.
 * Drive last, for anything that predates the move and has not been migrated.
 */
export function planFor(
  hasLocalBlob: boolean,
  driveFileId: string | undefined,
  r2Key?: string | undefined,
): HydrationAction {
  if (hasLocalBlob) return 'ready'
  if (r2Key) return 'r2'
  return driveFileId ? 'download' : 'missing'
}

/**
 * Every asset a project needs on this machine, without duplicates.
 *
 * Its library as well as everything the edit references, because the library is
 * what the second machine also has to be able to *show*: a file generated last
 * week and not yet cut in is one of this project's files, and a Library panel
 * that only filled in once something reached the timeline would look empty for
 * no reason anybody could see.
 */
export function neededAssetIds(project: Project): string[] {
  return [...new Set([...libraryAssetIdsOf(project), ...referencedAssetIds(project)])]
}

export interface HydrationProgress {
  done: number
  total: number
  /** Names of assets whose bytes could not be recovered. */
  failures: string[]
}

/** How many media downloads run at once. Large files, so not many. */
const DOWNLOAD_CONCURRENCY = 3

/**
 * Restores metadata and bytes for everything a project needs.
 *
 * Reports progress as it goes rather than resolving once at the end, so the UI
 * can show a project filling in instead of a spinner of unknown length.
 */
export async function hydrateProject(
  project: Project,
  known: Map<string, Asset>,
  onProgress: (progress: HydrationProgress) => void,
): Promise<Asset[]> {
  const needed = neededAssetIds(project)
  const unknown = needed.filter((id) => !known.has(id))

  // Pull down metadata for anything this browser has never heard of, and store
  // it locally so the library and timeline can render before any bytes land.
  const restored: Asset[] = []
  if (unknown.length > 0) {
    const rows = await getAssets(unknown)
    for (const row of rows) {
      const asset = fromRow(row, newId('blob'))
      await putAsset(asset)
      restored.push(asset)
    }
  }

  const all = [...known.values(), ...restored].filter((asset) => needed.includes(asset.id))

  const failures: string[] = []
  let done = 0
  const report = () => onProgress({ done, total: all.length, failures: [...failures] })
  report()

  await mapLimited(all, DOWNLOAD_CONCURRENCY, async (asset) => {
    try {
      const action = planFor(Boolean(await getBlob(asset.blobKey)), asset.driveFileId, asset.r2Key)

      if (action === 'r2' && asset.r2Key) {
        await putBlob(asset.blobKey, await downloadAsset(asset.r2Key))
      } else if (action === 'download' && asset.driveFileId) {
        await putBlob(asset.blobKey, await downloadFile(asset.driveFileId))
      } else if (action === 'missing') {
        failures.push(asset.name)
      }
    } catch (cause) {
      // One unrecoverable file must not abort the rest of the project.
      failures.push(`${asset.name} (${toDisplayMessage(cause)})`)
    } finally {
      done += 1
      report()
    }
  })

  return restored
}
