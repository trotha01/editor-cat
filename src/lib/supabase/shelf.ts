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
 *
 * **Every call names whose shelf it means.** It did not used to: there was
 * exactly one row a caller could see, so a bare select with no filter and a
 * `maybeSingle` was the whole read. Shares broke that — a member can now see
 * their own row *and* the owner's, and `maybeSingle` answers a second row with
 * an error rather than a choice — so the owner is a parameter, and passing your
 * own subject is what "my shelf" now looks like. See
 * supabase/migrations/0012_shelf_shares.sql.
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

/**
 * One account's shelf, or null when there has never been one.
 *
 * `ownerId` is the subject whose shelf is wanted — your own, or somebody who
 * has shared theirs with you. Row-level security is still what decides whether
 * the answer is a row or nothing; this filter is what makes the question
 * singular.
 */
export async function getShelf(ownerId: string): Promise<StoredShelf | null> {
  const { data, error } = await supabase()
    .from('word_shelves')
    .select('doc,schema_version,version')
    .eq('user_id', ownerId)
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
  ownerId: string,
): Promise<number | null> {
  if (expectedVersion === null) return await insertShelf(doc, ownerId)

  const { data, error } = await supabase()
    .from('word_shelves')
    .update({
      doc,
      schema_version: SHELF_SCHEMA_VERSION,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    // Both, and neither is redundant: the subject picks the row and the version
    // picks the moment. Without the first, a member's save would find the one
    // row a bare update could still see and write the wrong shelf.
    .eq('user_id', ownerId)
    .eq('version', expectedVersion)
    .select('version')
    .maybeSingle()

  if (error) throw new Error(error.message)
  // No row came back: the version guard matched nothing, so somebody else is
  // ahead of us.
  return data ? (data as { version: number }).version : null
}

/**
 * The first write of all.
 *
 * `user_id` is sent rather than defaulted now that it is not always the caller.
 * In practice this only ever runs for your own shelf — a shelf you were invited
 * to already had a row before anybody could be invited to it — but sending the
 * subject means the one case that could exist is spelled out rather than
 * silently landing on whoever happens to be signed in.
 */
async function insertShelf(doc: unknown, ownerId: string): Promise<number | null> {
  const { data, error } = await supabase()
    .from('word_shelves')
    .insert({ user_id: ownerId, doc, schema_version: SHELF_SCHEMA_VERSION })
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
