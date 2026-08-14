/**
 * The folder the word shelf was kept in, as the account remembers it.
 *
 * Read only, and only by recovery. This row used to be an answer the editor
 * needed on every sign-in — which folder new media goes into — and nothing
 * writes to Drive any more, so it is not that. What it still is, is the one
 * record of *where* the shelf's folder tree lives, and that tree is the only
 * remaining route to a take whose asset row was never written.
 *
 * So this is the reason `0011_drop_drive.sql` has to wait. It drops
 * `drive_folders`, and without the root id the tree is unreachable: `drive.file`
 * scope means the app can only see files it created, and it finds them by
 * walking down from here rather than by searching.
 *
 * `user_id` is never sent: the column defaults to `auth.jwt() ->> 'sub'` and
 * row-level security checks the same claim, so the row can only ever be the
 * caller's own — which is why the query has no `where` clause.
 */
import { supabase } from './client'

interface DriveFolderRow {
  folder_id: string
  folder_name: string
}

export interface DriveFolder {
  id: string
  name: string
}

/** The folder this account's shelf lives under, or null if there never was one. */
export async function getDriveFolder(): Promise<DriveFolder | null> {
  const { data, error } = await supabase()
    .from('drive_folders')
    .select('folder_id,folder_name')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  const row = data as DriveFolderRow
  return { id: row.folder_id, name: row.folder_name }
}
