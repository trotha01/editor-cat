/**
 * Reading and writing projects.
 *
 * `user_id` is never sent: the column defaults to `auth.jwt() ->> 'sub'` and
 * row-level security checks the same claim, so a client cannot write a row onto
 * someone else's account even by trying.
 */
import { supabase } from './client'
import { SCHEMA_VERSION, type Project, type ProjectDoc } from '../types'

/**
 * How long a deleted project can still be brought back.
 *
 * Stated here as well as in the database because the menu says how many days a
 * project has left without asking anyone. `purge_expired_projects` in
 * supabase/migrations/0008_project_archive.sql is the one that decides; this
 * describes it, and the two have to agree.
 */
export const RETENTION_DAYS = 90

/** Enough to render the project list without fetching every timeline. */
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  version: number
}

/** A deleted project, and how long is left to change your mind. */
export interface ArchivedProject extends ProjectSummary {
  deletedAt: string
}

/**
 * Whole days left before a deleted project is gone for good.
 *
 * Rounded up, so a project deleted a minute ago has the full ninety rather than
 * eighty-nine and a bit, and never reads as 0 while it can still be restored.
 * Clamped at the bottom because a purge only runs when a session starts: a row
 * can outlive its window and should say so as "today", not "-3 days".
 */
export function daysLeft(deletedAt: string, now = Date.now()): number {
  const expiry = Date.parse(deletedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((expiry - now) / (24 * 60 * 60 * 1000)))
}

/** A project as it exists on the server: the document plus its sync metadata. */
export interface StoredProject {
  id: string
  name: string
  doc: ProjectDoc
  schemaVersion: number
  version: number
  updatedAt: string
}

interface ProjectRow {
  id: string
  name: string
  doc: ProjectDoc
  schema_version: number
  version: number
  updated_at: string
}

/**
 * Splits the editable document away from the identity fields around it.
 *
 * By omission rather than by listing what to keep, and that is the whole point.
 * This used to name each field, which meant every field added to `Project`
 * afterwards had to be remembered here as well — and because all of them are
 * optional, forgetting one was not a type error. Four had been forgotten:
 * `videoTracks` and `videoClips` (the layered picture, schema 4),
 * `libraryAssetIds`, and `publications`, whose own doc comment in types.ts says
 * it is "on the project document, and therefore synced".
 *
 * The failure that shape produces is the worst kind. Editing works, saving
 * reports success, and the loss only appears on the next open on some other
 * machine — or on this one, after the remote document is applied over the local
 * one. A published video stopped being recognised as published, so the guard
 * against putting the same export in the feed twice quietly stopped guarding.
 *
 * `ProjectDoc` is already declared as `Omit<Project, 'id' | 'name' |
 * 'voiceovers'>`, so this now says the same thing the type says, and the next
 * field added is carried without anybody having to notice.
 *
 * `voiceovers` stays out because it is the pre-multitrack legacy list, read by
 * `migrateProject` on the way in and never written back.
 */
export function toDoc(project: Project): ProjectDoc {
  const { id: _id, name: _name, voiceovers: _voiceovers, ...doc } = project
  return doc
}

export function fromStored(stored: StoredProject): Project {
  return { id: stored.id, name: stored.name, ...stored.doc }
}

function toStored(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    name: row.name,
    doc: row.doc,
    schemaVersion: row.schema_version,
    version: row.version,
    updatedAt: row.updated_at,
  }
}

interface SummaryRow {
  id: string
  name: string
  updated_at: string
  version: number
}

function toSummary(row: SummaryRow): ProjectSummary {
  return { id: row.id, name: row.name, updatedAt: row.updated_at, version: row.version }
}

/** The projects that have not been deleted, newest edit first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase()
    .from('projects')
    .select('id,name,updated_at,version')
    // A deleted project is still a row, and still readable — it has to be, or it
    // could not be restored. It is this filter, not its absence from the table,
    // that keeps it out of the menu.
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map((row: SummaryRow) => toSummary(row))
}

/** The deleted ones, most recently deleted first. */
export async function listArchivedProjects(): Promise<ArchivedProject[]> {
  const { data, error } = await supabase()
    .from('projects')
    .select('id,name,updated_at,version,deleted_at')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map((row: SummaryRow & { deleted_at: string }) => ({
    ...toSummary(row),
    deletedAt: row.deleted_at,
  }))
}

export async function getProject(id: string): Promise<StoredProject | null> {
  const { data, error } = await supabase()
    .from('projects')
    .select('id,name,doc,schema_version,version,updated_at')
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data ? toStored(data as ProjectRow) : null
}

export async function createProject(name: string, doc: ProjectDoc): Promise<StoredProject> {
  const { data, error } = await supabase()
    .from('projects')
    .insert({ name, doc, schema_version: SCHEMA_VERSION })
    .select('id,name,doc,schema_version,version,updated_at')
    .single()

  if (error) throw new Error(error.message)
  return toStored(data as ProjectRow)
}

/** Raised when the row moved on before our write landed. */
export class ProjectConflictError extends Error {
  constructor() {
    super('This project was changed somewhere else. Reload to get the latest version.')
    this.name = 'ProjectConflictError'
  }
}

/**
 * Writes a new document, but only if the row is still at `expectedVersion`.
 *
 * The version guard is what makes a second tab or a second machine visible.
 * Without it the last writer silently wins and the other session's edits
 * disappear with nothing to indicate it happened.
 */
export async function updateProject(
  id: string,
  name: string,
  doc: ProjectDoc,
  expectedVersion: number,
): Promise<StoredProject> {
  const { data, error } = await supabase()
    .from('projects')
    .update({
      name,
      doc,
      schema_version: SCHEMA_VERSION,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('version', expectedVersion)
    .select('id,name,doc,schema_version,version,updated_at')
    .maybeSingle()

  if (error) throw new Error(error.message)
  // No row came back: either the version guard failed, or the row is gone.
  // Both mean this session's copy is stale.
  if (!data) throw new ProjectConflictError()
  return toStored(data as ProjectRow)
}

/** Raised when a project is not there to be archived, restored or opened. */
export class ProjectMissingError extends Error {
  constructor() {
    super('That project no longer exists.')
    this.name = 'ProjectMissingError'
  }
}

/**
 * Deletes a project, reversibly, and says when the clock started.
 *
 * Through a function because the stamp has to be the server's: see
 * supabase/migrations/0008_project_archive.sql. It is the moment the ninety days
 * are counted from, and a browser with a wrong clock would be counting from
 * somewhere else entirely.
 */
export async function archiveProject(id: string): Promise<string> {
  const { data, error } = await supabase().rpc('archive_project', { project_id: id })

  if (error) throw new Error(error.message)
  // Null means the policy matched nothing: already deleted, or never theirs.
  if (typeof data !== 'string') throw new ProjectMissingError()
  return data
}

/** Puts a deleted project back in the list. */
export async function restoreProject(id: string): Promise<ProjectSummary> {
  const { data, error } = await supabase()
    .from('projects')
    .update({ deleted_at: null })
    .eq('id', id)
    .select('id,name,updated_at,version')
    .maybeSingle()

  if (error) throw new Error(error.message)
  // Gone in the meantime — most plausibly purged, on a window that had run out
  // while this menu was open.
  if (!data) throw new ProjectMissingError()
  return toSummary(data as SummaryRow)
}

/**
 * Clears out projects whose ninety days have run out, ignoring failures.
 *
 * Called when a session starts, which is the only clock this app has: there is
 * no scheduler behind it, so a project is purged the next time its owner comes
 * back rather than the day it expires. Row-level security keeps the sweep to the
 * caller's own projects. See the migration for the pg_cron version, which does
 * not depend on anyone signing in.
 */
export async function purgeExpiredProjects(): Promise<void> {
  try {
    // The result is deliberately not inspected. A deployment that has not run
    // 0008 answers "function not found" every time, and neither the person in
    // front of it nor this code can do anything about that.
    await supabase().rpc('purge_expired_projects')
  } catch {
    // Nothing here is worth interrupting a sign-in over, and the next session
    // tries again.
  }
}
