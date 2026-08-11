/**
 * The folder new media is written into, as the account remembers it.
 *
 * One row per user, and the authority on the question: this is what makes a
 * sign-in on a second machine — or a second sign-in on the same one — skip the
 * folder step instead of asking something the user already answered. The browser
 * keeps a copy in localStorage, but only as a cache for when this cannot be
 * reached; see state/useDriveStore.ts.
 *
 * `user_id` is never sent: the column defaults to `auth.jwt() ->> 'sub'` and
 * row-level security checks the same claim, so the row can only ever be the
 * caller's own — which is also why no query here has a `where` clause.
 */
import { supabase } from './client'
import type { DriveFolder } from '../google/drive'

interface DriveFolderRow {
  folder_id: string
  folder_name: string
}

/** The folder this account chose, or null if it has never chosen one. */
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

/** Records the choice, replacing whatever was there before. */
export async function saveDriveFolder(folder: DriveFolder): Promise<void> {
  const { error } = await supabase()
    .from('drive_folders')
    // `updated_at` is in the payload rather than left to the column default,
    // which only applies to the insert half of an upsert — a folder changed in
    // Settings would otherwise keep the timestamp of the first choice.
    .upsert(
      {
        folder_id: folder.id,
        folder_name: folder.name,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )

  if (error) throw new Error(error.message)
}

/**
 * Forgets the account's choice, so the next sign-in asks again.
 *
 * Deliberately not what signing out does. Signing out clears this browser's copy
 * because the folder belongs to whoever was signed in; the account's own record
 * is the thing that survives it, and deleting that here would put the question
 * back in front of them next time — the bug this table exists to fix.
 */
export async function clearDriveFolder(): Promise<void> {
  // Every row this caller can see is their own, by policy — so an unfiltered
  // delete removes exactly one row. PostgREST refuses one with no filter at all,
  // hence a predicate that is true of any row that exists.
  const { error } = await supabase().from('drive_folders').delete().not('folder_id', 'is', null)
  if (error) throw new Error(error.message)
}
