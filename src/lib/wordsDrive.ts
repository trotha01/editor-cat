/**
 * The word pages, as folders in the user's Drive.
 *
 * A folder per language, a folder per word inside it, that word's videos in that
 * folder, and one small JSON file beside them holding the order and the labels
 * (see `SIDECAR_NAME` in lib/words.ts). This module is the half that talks to
 * Drive; the reconciling is pure and lives next to the model.
 *
 * Everything here works under `drive.file`, which is both what makes it safe —
 * the app can see the folders it made and nothing else of anybody's Drive — and
 * the one real limit: a language folder somebody created by hand is invisible
 * until they hand it over through the Picker, so this makes its own rather than
 * silently writing into a folder it cannot see.
 */
import {
  createFolder,
  downloadFile,
  isFolder,
  kindForMime,
  listChildren,
  updateFileContent,
  uploadFile,
  type DriveChild,
} from './google/drive'
import { mapLimited } from './concurrency'
import { parseSidecar, SIDECAR_NAME, type WordSidecar } from './words'

/** How many folders are read at once. Drive throttles a wide fan-out. */
const LIST_CONCURRENCY = 4

/** Matches the names people type against the names Drive holds. */
function sameFolderName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0
}

/**
 * The folder of this name under `parentId`, made if it is not there.
 *
 * Looked up rather than assumed, so a language added on one machine and then on
 * another does not end up with two folders — and so the second machine adopts
 * the first one's folder rather than starting a rival copy of the same word.
 */
export async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const existing = (await listChildren(parentId)).find(
    (child) => isFolder(child) && sameFolderName(child.name, name),
  )
  if (existing) return existing.id
  return (await createFolder(name, parentId)).id
}

/** A word folder as Drive holds it, before any of it is matched up with local state. */
export interface RawWord {
  folderId: string
  name: string
  /** Video files only: the sidecar and anything else in there is not a take. */
  files: DriveChild[]
  sidecar: WordSidecar | null
}

export interface RawLanguage {
  folderId: string
  name: string
  words: RawWord[]
}

/**
 * Reads the whole shelf: every language folder, its word folders, and what is in
 * them.
 *
 * Three levels of listing, which sounds like a lot until you notice what it
 * replaces — a table, a schema, a migration and a sync protocol. The shelf is
 * small (folders and names), the videos are named but not fetched, and the only
 * bytes that come down are the sidecars, which are a few hundred of them each.
 */
export async function readShelf(rootId: string, signal?: AbortSignal): Promise<RawLanguage[]> {
  const languages = (await listChildren(rootId, signal)).filter(isFolder)

  return await mapLimited(languages, LIST_CONCURRENCY, async (folder) => {
    const wordFolders = (await listChildren(folder.id, signal)).filter(isFolder)
    const words = await mapLimited(wordFolders, LIST_CONCURRENCY, async (wordFolder) =>
      readWord(wordFolder, signal),
    )
    return { folderId: folder.id, name: folder.name, words }
  })
}

async function readWord(folder: DriveChild, signal?: AbortSignal): Promise<RawWord> {
  const children = await listChildren(folder.id, signal)
  const files = children.filter(
    (child) => !isFolder(child) && kindForMime(child.mimeType) === 'video',
  )
  const sidecarFile = children.find((child) => child.name === SIDECAR_NAME)

  let sidecar: WordSidecar | null = null
  if (sidecarFile) {
    try {
      sidecar = parseSidecar(await (await downloadFile(sidecarFile.id, signal)).text())
    } catch {
      // A sidecar that will not come down costs the order and the labels, not
      // the videos. Read the folder anyway.
    }
  }

  return { folderId: folder.id, name: folder.name, files, sidecar }
}

/**
 * Writes a word's order, labels and transcripts beside its videos.
 *
 * The file is looked up by name each time rather than remembered, which costs
 * one listing per write and buys a great deal: nothing has to store a second
 * Drive id, a sidecar deleted by hand simply comes back, and two machines
 * writing the same word converge on the one file instead of littering the folder
 * with copies.
 */
export async function writeSidecar(wordFolderId: string, sidecar: WordSidecar): Promise<void> {
  const blob = new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' })
  const existing = (await listChildren(wordFolderId)).find((child) => child.name === SIDECAR_NAME)

  if (existing) {
    await updateFileContent(existing.id, blob)
    return
  }
  await uploadFile(blob, { name: SIDECAR_NAME, parentId: wordFolderId })
}
