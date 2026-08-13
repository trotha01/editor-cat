/**
 * The layer between the shelf and the Drive API.
 *
 * Small, and every piece of it is a decision that would be invisible if it went
 * wrong. A folder created without looking first is the second copy of a language
 * somebody already has. And reading a word folder has to tell three kinds of
 * thing apart — the takes, the old sidecar, and whatever else happens to be in
 * there — from nothing but a MIME type and a name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveChild } from './google/drive'

const listChildren = vi.fn<(parentId: string) => Promise<DriveChild[]>>()
const createFolder = vi.fn<(name: string, parentId: string) => Promise<{ id: string }>>()
const downloadFile = vi.fn<(fileId: string) => Promise<Blob>>()

const FOLDER_MIME = 'application/vnd.google-apps.folder'

vi.mock('./google/drive', () => ({
  FOLDER_MIME,
  isFolder: (child: DriveChild) => child.mimeType === FOLDER_MIME,
  kindForMime: (mimeType: string) => (mimeType.startsWith('video/') ? 'video' : null),
  listChildren: (parentId: string) => listChildren(parentId),
  createFolder: (name: string, parentId: string) => createFolder(name, parentId),
  downloadFile: (fileId: string) => downloadFile(fileId),
}))

const { findOrCreateFolder, readShelf } = await import('./wordsDrive')
const { SIDECAR_NAME } = await import('./words')

const folder = (id: string, name: string): DriveChild => ({ id, name, mimeType: FOLDER_MIME })
const file = (id: string, name: string, mimeType = 'video/mp4'): DriveChild => ({
  id,
  name,
  mimeType,
})

/** Answers each listing from a map of folder id to contents. */
function drive(tree: Record<string, DriveChild[]>) {
  listChildren.mockImplementation((parentId) => Promise.resolve(tree[parentId] ?? []))
}

beforeEach(() => {
  listChildren.mockReset()
  createFolder.mockReset()
  createFolder.mockImplementation((name) => Promise.resolve({ id: `made_${name}` }))
  downloadFile.mockReset()
})

describe('findOrCreateFolder', () => {
  it('takes the folder that is already there, whatever case it was named in', async () => {
    drive({ root: [folder('folder_es', 'Spanish')] })

    expect(await findOrCreateFolder('spanish', 'root')).toBe('folder_es')
    expect(createFolder).not.toHaveBeenCalled()
  })

  it('does not mistake a file of the same name for the folder', async () => {
    drive({ root: [file('file_es', 'Spanish', 'video/mp4')] })

    expect(await findOrCreateFolder('Spanish', 'root')).toBe('made_Spanish')
  })

  it('makes one when there is none', async () => {
    drive({ root: [] })

    expect(await findOrCreateFolder('Spanish', 'root')).toBe('made_Spanish')
    expect(createFolder).toHaveBeenCalledWith('Spanish', 'root')
  })
})

describe('readShelf', () => {
  it('reads tiers, languages, their words, their takes and the order beside them', async () => {
    drive({
      root: [folder('folder_first', '1st tier'), file('stray', 'holiday.mp4')],
      folder_first: [folder('folder_es', 'Spanish')],
      folder_es: [folder('folder_gato', 'gato')],
      folder_gato: [
        file('f1', 'intro.mp4'),
        file('f2', 'gato.mov', 'video/quicktime'),
        file('sidecar', SIDECAR_NAME, 'application/json'),
        file('notes', 'notes.txt', 'text/plain'),
      ],
    })
    downloadFile.mockResolvedValue(
      new Blob([
        JSON.stringify({
          version: 1,
          word: 'gato',
          videos: [{ driveFileId: 'f2', role: 'outro' }],
        }),
      ]),
    )

    const shelf = await readShelf('root')

    // The loose video in the media folder is not a tier, and the text file is
    // not a take.
    expect(shelf).toHaveLength(1)
    expect(shelf[0]?.name).toBe('1st tier')
    expect(shelf[0]?.languages[0]?.name).toBe('Spanish')

    const gato = shelf[0]?.languages[0]?.words[0]
    expect(gato?.files.map((entry) => entry.id)).toEqual(['f1', 'f2'])
    expect(gato?.sidecar?.videos).toEqual([{ driveFileId: 'f2', role: 'outro' }])
  })

  it('still reads the folder when the sidecar will not come down', async () => {
    drive({
      root: [folder('folder_first', '1st tier')],
      folder_first: [folder('folder_es', 'Spanish')],
      folder_es: [folder('folder_gato', 'gato')],
      folder_gato: [file('f1', 'intro.mp4'), file('sidecar', SIDECAR_NAME, 'application/json')],
    })
    downloadFile.mockRejectedValue(new Error('nope'))

    const shelf = await readShelf('root')

    const gato = shelf[0]?.languages[0]?.words[0]
    expect(gato?.files.map((entry) => entry.id)).toEqual(['f1'])
    expect(gato?.sidecar).toBeNull()
  })
})
