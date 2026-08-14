/**
 * Asset metadata.
 *
 * The bytes are never here — they are in our own R2 bucket, in the user's Drive
 * while that still exists, and in IndexedDB. What this table carries is
 * everything needed to *find* them again: the R2 key and the Drive file id,
 * plus the dimensions and durations that let a timeline lay itself out before a
 * single byte has been fetched.
 */
import { supabase } from './client'
import type { Asset } from '../types'

interface AssetRow {
  id: string
  kind: Asset['kind']
  name: string
  mime_type: string
  width: number | null
  height: number | null
  duration: number | null
  prompt: string | null
  source_url: string | null
  drive_file_id: string | null
  r2_key: string | null
  byte_size: number | null
  created_at: string
}

function toRow(asset: Asset, byteSize?: number) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    mime_type: asset.mimeType,
    width: asset.width ?? null,
    height: asset.height ?? null,
    duration: asset.duration ?? null,
    prompt: asset.prompt ?? null,
    source_url: asset.sourceUrl ?? null,
    drive_file_id: asset.driveFileId ?? null,
    r2_key: asset.r2Key ?? null,
    byte_size: byteSize ?? null,
    created_at: new Date(asset.createdAt).toISOString(),
  }
}

/**
 * Rebuilds the local Asset shape from a row.
 *
 * `blobKey` is deliberately regenerated rather than stored: it names an
 * IndexedDB entry on one machine and means nothing anywhere else.
 */
export function fromRow(row: AssetRow, blobKey: string): Asset {
  return {
    id: row.id,
    kind: row.kind,
    blobKey,
    mimeType: row.mime_type,
    name: row.name,
    createdAt: Date.parse(row.created_at) || Date.now(),
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.duration !== null ? { duration: row.duration } : {}),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.source_url !== null ? { sourceUrl: row.source_url } : {}),
    ...(row.drive_file_id !== null ? { driveFileId: row.drive_file_id } : {}),
    ...(row.r2_key !== null ? { r2Key: row.r2_key } : {}),
  }
}

/** Writes an asset's metadata, replacing any previous row for the same id. */
export async function upsertAsset(asset: Asset, byteSize?: number): Promise<void> {
  const { error } = await supabase()
    .from('assets')
    .upsert(toRow(asset, byteSize), { onConflict: 'user_id,id' })
  if (error) throw new Error(error.message)
}

/**
 * How many ids `in.(...)` carries in one request.
 *
 * A timeline asks for a handful; a whole word shelf can ask for hundreds — every
 * take of every word on the account, in one call (see `hydrateShelfAssets`). The
 * query string is `id=in.(id1,id2,...)`, so that grows without bound too, and a
 * long enough one has nowhere good to fail: not a row-shaped error, just a
 * request that never lands. Chunked, the same account asks in several requests
 * short enough that none of them are a novelty to whatever sits between the
 * browser and Postgres.
 */
const ASSET_ID_BATCH = 100

/** Fetches metadata for a specific set of assets — what a timeline references. */
export async function getAssets(ids: string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return []
  const batches: string[][] = []
  for (let at = 0; at < ids.length; at += ASSET_ID_BATCH)
    batches.push(ids.slice(at, at + ASSET_ID_BATCH))

  const rows = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase().from('assets').select('*').in('id', batch)
      if (error) throw new Error(error.message)
      return (data ?? []) as AssetRow[]
    }),
  )
  return rows.flat()
}

/** The whole library, for populating a machine that has never seen it. */
export async function listAssets(): Promise<AssetRow[]> {
  const { data, error } = await supabase()
    .from('assets')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetRow[]
}
