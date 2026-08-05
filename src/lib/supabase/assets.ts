/**
 * Asset metadata.
 *
 * The bytes are never here — they are in the user's Drive and in IndexedDB.
 * What this table carries is everything needed to *find* them again: the
 * Drive file id, plus the dimensions and durations that let a timeline lay
 * itself out before a single byte has been fetched.
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
  }
}

/** Writes an asset's metadata, replacing any previous row for the same id. */
export async function upsertAsset(asset: Asset, byteSize?: number): Promise<void> {
  const { error } = await supabase()
    .from('assets')
    .upsert(toRow(asset, byteSize), { onConflict: 'user_id,id' })
  if (error) throw new Error(error.message)
}

/** Fetches metadata for a specific set of assets — what a timeline references. */
export async function getAssets(ids: string[]): Promise<AssetRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase().from('assets').select('*').in('id', ids)
  if (error) throw new Error(error.message)
  return (data ?? []) as AssetRow[]
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
