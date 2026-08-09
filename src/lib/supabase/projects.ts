/**
 * Reading and writing projects.
 *
 * `user_id` is never sent: the column defaults to `auth.uid()` and row-level
 * security checks it, so a client cannot write a row onto someone else's
 * account even by trying.
 */
import { supabase } from './client'
import { SCHEMA_VERSION, type Project, type ProjectDoc } from '../types'

/** Enough to render the project list without fetching every timeline. */
export interface ProjectSummary {
  id: string
  name: string
  updatedAt: string
  version: number
  /**
   * Carried in the summary as well as on the project itself, because the folder
   * ids other projects hold are what stops a lookup by name from handing one
   * project the folder of another called the same thing.
   */
  driveFolderId?: string
}

/** A project as it exists on the server: the document plus its sync metadata. */
export interface StoredProject {
  id: string
  name: string
  doc: ProjectDoc
  schemaVersion: number
  version: number
  updatedAt: string
  /** The project's own folder in Drive. Absent until one has been made. */
  driveFolderId?: string
}

interface ProjectRow {
  id: string
  name: string
  doc: ProjectDoc
  schema_version: number
  version: number
  updated_at: string
  drive_folder_id: string | null
}

/** Every column a whole project is read back through. */
const PROJECT_FIELDS = 'id,name,doc,schema_version,version,updated_at,drive_folder_id'

/**
 * Splits the editable document away from the identity fields around it.
 *
 * `driveFolderId` is one of those fields and is deliberately not written here.
 * It has a column of its own, set by `setProjectDriveFolder` outside the version
 * guard, so putting it in the document would give it a second home that a stale
 * push could overwrite with an older answer.
 */
export function toDoc(project: Project): ProjectDoc {
  return {
    clips: project.clips,
    audioTracks: project.audioTracks,
    audioClips: project.audioClips,
    width: project.width,
    height: project.height,
    fps: project.fps,
    // Only written when there is one, so documents that never had a lead-in
    // stay byte-identical and an older client reading one is unaffected.
    ...(project.leadIn ? { leadIn: project.leadIn } : {}),
    // Same reasoning for captions: a project with none writes neither key, so
    // adding the feature does not rewrite every stored document.
    ...(project.captionTracks?.length ? { captionTracks: project.captionTracks } : {}),
    ...(project.captionCues?.length ? { captionCues: project.captionCues } : {}),
  }
}

export function fromStored(stored: StoredProject): Project {
  return {
    id: stored.id,
    name: stored.name,
    ...stored.doc,
    // Only written when there is one, so a project with no folder of its own
    // round-trips to exactly the shape it had rather than growing an empty key.
    ...(stored.driveFolderId ? { driveFolderId: stored.driveFolderId } : {}),
  }
}

function toStored(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    name: row.name,
    doc: row.doc,
    schemaVersion: row.schema_version,
    version: row.version,
    updatedAt: row.updated_at,
    ...(row.drive_folder_id ? { driveFolderId: row.drive_folder_id } : {}),
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase()
    .from('projects')
    .select('id,name,updated_at,version,drive_folder_id')
    .order('updated_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map(
    (row: {
      id: string
      name: string
      updated_at: string
      version: number
      drive_folder_id: string | null
    }) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      version: row.version,
      ...(row.drive_folder_id ? { driveFolderId: row.drive_folder_id } : {}),
    }),
  )
}

export async function getProject(id: string): Promise<StoredProject | null> {
  const { data, error } = await supabase()
    .from('projects')
    .select(PROJECT_FIELDS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data ? toStored(data as ProjectRow) : null
}

export async function createProject(name: string, doc: ProjectDoc): Promise<StoredProject> {
  const { data, error } = await supabase()
    .from('projects')
    .insert({ name, doc, schema_version: SCHEMA_VERSION })
    .select(PROJECT_FIELDS)
    .single()

  if (error) throw new Error(error.message)
  return toStored(data as ProjectRow)
}

/**
 * Records which folder in Drive a project's media goes into.
 *
 * A write of its own rather than part of the document push, and deliberately
 * outside the version guard. Nobody edited anything: this is where a folder that
 * already exists turned out to be, so counting it as a new version would reject
 * the next push from a tab that is mid-edit and agrees with us completely.
 *
 * It also leaves `updated_at` alone, so discovering a folder does not reshuffle
 * the project list under someone.
 */
export async function setProjectDriveFolder(id: string, driveFolderId: string): Promise<void> {
  const { error } = await supabase()
    .from('projects')
    .update({ drive_folder_id: driveFolderId })
    .eq('id', id)

  if (error) throw new Error(error.message)
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
    .select(PROJECT_FIELDS)
    .maybeSingle()

  if (error) throw new Error(error.message)
  // No row came back: either the version guard failed, or the row is gone.
  // Both mean this session's copy is stale.
  if (!data) throw new ProjectConflictError()
  return toStored(data as ProjectRow)
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase().from('projects').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
