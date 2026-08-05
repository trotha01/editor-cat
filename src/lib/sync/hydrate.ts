/**
 * Refilling a machine that has the timeline but not the media.
 *
 * Opening a project on a second device gives you a document full of asset ids
 * and an empty IndexedDB. The metadata rows say what those assets are — enough
 * to lay the timeline out immediately — and their `drive_file_id` says where
 * the bytes actually live.
 *
 * Metadata is restored first and bytes second, on purpose: the editor is
 * usable, scrubbable and re-orderable while the downloads are still running.
 */
import { getAssets, fromRow } from '../supabase/assets'
import { downloadFile } from '../google/drive'
import { getBlob, putAsset, putBlob } from '../db'
import { mapLimited } from '../concurrency'
import { newId } from '../media'
import { toDisplayMessage } from '../errors'
import type { Asset, Project } from '../types'

/** What has to happen for one asset before it can play. */
export type HydrationAction =
  /** Bytes are already in this browser. */
  | 'ready'
  /** Bytes must come down from Drive. */
  | 'download'
  /** Nothing to fetch: never backed up, or Drive was never connected. */
  | 'missing'

export function planFor(hasLocalBlob: boolean, driveFileId: string | undefined): HydrationAction {
  if (hasLocalBlob) return 'ready'
  return driveFileId ? 'download' : 'missing'
}

/** Every asset id a project refers to, visual and audio, without duplicates. */
export function referencedAssetIds(project: Project): string[] {
  const ids = new Set<string>()
  for (const clip of project.clips) ids.add(clip.assetId)
  for (const clip of project.audioClips) {
    ids.add(clip.assetId)
    // The converted take is a separate asset and is what plays when the clip is
    // set to use it, so a project that opens without it is missing audio.
    if (clip.convertedAssetId) ids.add(clip.convertedAssetId)
  }
  return [...ids]
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
  const referenced = referencedAssetIds(project)
  const unknown = referenced.filter((id) => !known.has(id))

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

  const all = [...known.values(), ...restored].filter((asset) => referenced.includes(asset.id))

  const failures: string[] = []
  let done = 0
  const report = () => onProgress({ done, total: all.length, failures: [...failures] })
  report()

  await mapLimited(all, DOWNLOAD_CONCURRENCY, async (asset) => {
    try {
      const action = planFor(Boolean(await getBlob(asset.blobKey)), asset.driveFileId)

      if (action === 'download' && asset.driveFileId) {
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
