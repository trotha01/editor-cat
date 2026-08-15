/**
 * Finding files in storage that nothing points at any more.
 *
 * Two ways they accumulate, and neither is a bug on its own.
 *
 * Removing a take from a word unhooks it from the shelf and clears this
 * browser's copy of the bytes; the object and its row stay, because at that
 * moment nothing knows whether some other machine still wants them. And a row
 * deleted by hand — or by anything that outlives its object — leaves the object
 * behind with nothing left to name it.
 *
 * The feed side does not have this problem: a `Publication` records exactly
 * which objects it wrote, so taking a video down is a known-length batch. There
 * is no equivalent for assets, because an asset is not owned by one thing. So
 * this asks the other question instead — what does *anything* still reference?
 * — and treats the remainder as unused.
 *
 * **Nothing here is best-effort, and that is the whole design.** Every source of
 * references either answers or throws, and a throw abandons the sweep. A
 * project that fails to load must never read as a project that references
 * nothing: that is the difference between "this file is unused" and "I could
 * not find out", and only one of them is safe to act on.
 *
 * Archived projects count. A deleted project is restorable for ninety days
 * (`0008`), so its media is still spoken for, and sweeping it would empty a
 * project somebody was about to bring back.
 */
import { getShelf } from '../supabase/shelf'
import { listAssets, deleteAssets } from '../supabase/assets'
import { fromStored, getProject, listArchivedProjects, listProjects } from '../supabase/projects'
import { libraryAssetIdsOf, referencedAssetIds } from '../library'
import { parseShelfDoc } from '../words'
import { auth0Token } from '../auth0/client'
import { isMockEnabled } from '../mock'

/** One file the sweep would remove. */
export interface UnusedAsset {
  id: string
  name: string
  /** Null for a row whose upload never finished; the row still goes. */
  key: string | null
  bytes: number
}

export interface UnusedFiles {
  /** Rows nothing references, and the objects behind them. */
  assets: UnusedAsset[]
  /**
   * Objects with no row at all.
   *
   * Not reachable by any code path — an asset is found by its row — so these
   * are pure residue, and the only thing that can name them is a listing.
   */
  strayKeys: string[]
  /** What removing all of it would free, as far as the rows record it. */
  bytes: number
}

/** How many keys one delete request may name. Matches the endpoint's cap. */
const DELETE_BATCH = 512

/** `asset/<hash>/<assetId>` — the id is the last segment. */
export function assetIdOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

async function listing(signal?: AbortSignal): Promise<string[]> {
  if (isMockEnabled()) return []
  const token = await auth0Token()
  const response = await fetch('/api/r2/listing', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal,
    body: '{}',
  })
  if (!response.ok) throw new Error(`Could not list your stored files (${response.status}).`)
  return ((await response.json()) as { keys?: string[] }).keys ?? []
}

/**
 * Every asset id anything still points at.
 *
 * The word shelf, then every project the account has — open, closed, and
 * archived. Deliberately no try/catch anywhere in here: an unanswered question
 * has to reach the caller as a failure, because the caller's next move is to
 * delete whatever this did not mention.
 */
async function referencedIds(): Promise<Set<string>> {
  const ids = new Set<string>()

  const shelf = await getShelf()
  if (shelf) {
    for (const word of parseShelfDoc(shelf.doc).words) {
      for (const video of word.videos) ids.add(video.assetId)
    }
  }

  const summaries = [...(await listProjects()), ...(await listArchivedProjects())]
  for (const summary of summaries) {
    const stored = await getProject(summary.id)
    // Null is a row that is genuinely not there — `getProject` throws rather
    // than returning null when the read itself fails, so this is not a
    // swallowed error.
    if (!stored) continue
    const project = fromStored(stored)
    for (const id of libraryAssetIdsOf(project)) ids.add(id)
    for (const id of referencedAssetIds(project)) ids.add(id)
  }

  return ids
}

/** What is in storage that nothing wants. Reads only; deletes nothing. */
export async function unusedFiles(signal?: AbortSignal): Promise<UnusedFiles> {
  const referenced = await referencedIds()
  const rows = await listAssets()
  const keys = await listing(signal)

  const known = new Set(rows.map((row) => row.id))

  const assets = rows
    .filter((row) => !referenced.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      key: row.r2_key,
      bytes: row.byte_size ?? 0,
    }))

  return {
    assets,
    strayKeys: keys.filter((key) => !known.has(assetIdOf(key))),
    bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
  }
}

async function deleteObjects(keys: readonly string[], signal?: AbortSignal): Promise<void> {
  if (keys.length === 0 || isMockEnabled()) return
  const token = await auth0Token()

  for (let index = 0; index < keys.length; index += DELETE_BATCH) {
    const response = await fetch('/api/r2/deletes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
      body: JSON.stringify({ scope: 'asset', keys: keys.slice(index, index + DELETE_BATCH) }),
    })
    if (!response.ok) throw new Error(`Could not remove those files (${response.status}).`)
  }
}

export interface SweepSummary {
  /** Rows forgotten. */
  assets: number
  /** Objects removed, residue included. */
  objects: number
  bytes: number
}

/**
 * Removes what `unusedFiles` found.
 *
 * **Rows first, objects second**, which is the opposite of the feed's teardown
 * and for a reason worth stating. If the row goes and the object delete fails,
 * what is left is an object nothing names — which is exactly what `strayKeys`
 * finds, so the next run cleans it up. The other order fails worse: an object
 * gone while its row survives is a row pointing at nothing, and that surfaces
 * as a file that will not load rather than as tidying left half-done.
 *
 * Takes the result it was given rather than recomputing. The count on screen is
 * what the person agreed to, and a sweep that quietly widened between the
 * question and the answer would be the one thing this must not do.
 */
export async function sweepUnused(found: UnusedFiles, signal?: AbortSignal): Promise<SweepSummary> {
  const keys = [
    ...found.assets.map((asset) => asset.key).filter((key): key is string => Boolean(key)),
    ...found.strayKeys,
  ]

  await deleteAssets(found.assets.map((asset) => asset.id))
  await deleteObjects(keys, signal)

  return { assets: found.assets.length, objects: keys.length, bytes: found.bytes }
}
