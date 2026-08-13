/**
 * The word shelf, kept against the account.
 *
 * One row per user holding the whole shelf as a document — see
 * supabase/migrations/0009_word_shelf.sql for why it is a document rather than
 * four tables. The videos are not here and never were: they are files in the
 * user's Drive, and what this carries is the shelf around them, which is the
 * part a folder could not hold.
 *
 * Guarded by a version the same way projects are, so a second tab or a second
 * machine cannot silently overwrite. A conflict is not an error here, though —
 * the shelf is one document per person rather than a document per project, so
 * the answer is always "re-read, fold ours in, write again" and never "tell the
 * user to reload". That is why a stale write returns null rather than throwing.
 */
import { supabase } from './client'

/** The shelf as it exists on the server: the document plus its version. */
export interface StoredShelf {
  doc: unknown
  version: number
}

interface ShelfRow {
  doc: unknown
  schema_version: number
  version: number
}

/** What this client writes. Bumped when the document's shape moves on. */
export const SHELF_SCHEMA_VERSION = 1

/** The account's shelf, or null when there has never been one. */
export async function getShelf(): Promise<StoredShelf | null> {
  const { data, error } = await supabase()
    .from('word_shelves')
    .select('doc,schema_version,version')
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!data) return null

  const row = data as ShelfRow
  return { doc: row.doc, version: row.version }
}

/**
 * Writes the shelf, and says what version it is now.
 *
 * `expectedVersion` is null for the first write of all, which is an insert: a
 * row that turns out to exist already means another machine wrote one between
 * our read and our write, and comes back as a conflict like any other.
 *
 * Null means the write did not land because the row had moved on. The caller
 * re-reads, merges, and calls again.
 */
export async function putShelf(
  doc: unknown,
  expectedVersion: number | null,
): Promise<number | null> {
  if (expectedVersion === null) return await insertShelf(doc)

  const { data, error } = await supabase()
    .from('word_shelves')
    .update({
      doc,
      schema_version: SHELF_SCHEMA_VERSION,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('version', expectedVersion)
    .select('version')
    .maybeSingle()

  if (error) throw new Error(error.message)
  // No row came back: the version guard matched nothing, so somebody else is
  // ahead of us.
  return data ? (data as { version: number }).version : null
}

async function insertShelf(doc: unknown): Promise<number | null> {
  const { data, error } = await supabase()
    .from('word_shelves')
    .insert({ doc, schema_version: SHELF_SCHEMA_VERSION })
    .select('version')
    .maybeSingle()

  // A primary key collision is the other machine having got there first, which
  // is a conflict rather than a failure — everything else is a real error.
  if (error) {
    if (error.code === '23505') return null
    throw new Error(error.message)
  }
  return data ? (data as { version: number }).version : null
}
