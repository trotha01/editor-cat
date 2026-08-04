/**
 * Picks the Drive folder that generated media gets saved into.
 *
 * This is a hand-built browser rather than the Google Picker widget. The Picker
 * would need two more credentials (an API key and the Cloud project number)
 * wired into the deployment, and it cannot be styled — for a drill-down over
 * `files.list`, which we are already authorised to call, that is a poor trade.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Modal, Spinner, TextInput } from './ui'
import { createFolder, listSubfolders, ROOT_FOLDER_ID, type DriveFolder } from '../lib/google/drive'
import { toDisplayMessage } from '../lib/errors'

const MY_DRIVE: DriveFolder = { id: ROOT_FOLDER_ID, name: 'My Drive' }

export function DriveFolderPicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  onSelect: (folder: DriveFolder) => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Choose a Drive folder" wide>
      {/* Mounted only while open, so every visit starts at My Drive with a
          clean breadcrumb. A stale trail from last time is worse than none. */}
      {open ? <FolderBrowser onClose={onClose} onSelect={onSelect} /> : null}
    </Modal>
  )
}

/**
 * Results are tagged with the folder they belong to rather than being paired
 * with a separate `loading` flag. That makes a slow response for a folder the
 * user has already navigated away from unrenderable by construction, and
 * "still loading" simply means "no result for the current folder yet".
 */
interface Loaded<T> {
  forId: string
  value: T
}

function FolderBrowser({
  onClose,
  onSelect,
}: {
  onClose: () => void
  onSelect: (folder: DriveFolder) => void
}) {
  /** Breadcrumb trail; the last entry is the folder being shown. */
  const [path, setPath] = useState<DriveFolder[]>([MY_DRIVE])
  const [result, setResult] = useState<Loaded<DriveFolder[]> | null>(null)
  const [error, setError] = useState<Loaded<string> | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const current = path[path.length - 1] ?? MY_DRIVE
  const folders = result?.forId === current.id ? result.value : null
  const message = error?.forId === current.id ? error.value : null
  const loading = folders === null && message === null

  useEffect(() => {
    let cancelled = false
    listSubfolders(current.id).then(
      (value) => {
        if (!cancelled) setResult({ forId: current.id, value })
      },
      (cause: unknown) => {
        if (!cancelled) setError({ forId: current.id, value: toDisplayMessage(cause) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [current.id])

  const openFolder = (folder: DriveFolder) => setPath((entries) => [...entries, folder])
  const goTo = (index: number) => setPath((entries) => entries.slice(0, index + 1))

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const folder = await createFolder(name, current.id)
      setNewName('')
      openFolder(folder)
    } catch (cause) {
      setError({ forId: current.id, value: toDisplayMessage(cause) })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Folder path">
        {path.map((entry, index) => (
          <span key={entry.id} className="flex items-center gap-1">
            {index > 0 ? (
              <span aria-hidden className="text-ink-dim">
                /
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => goTo(index)}
              disabled={index === path.length - 1}
              className="rounded px-1.5 py-0.5 text-ink-dim hover:bg-surface-2 hover:text-ink disabled:font-medium disabled:text-ink disabled:hover:bg-transparent"
            >
              {entry.name}
            </button>
          </span>
        ))}
      </nav>

      {message ? (
        <Callout tone="error" title="Could not read that folder">
          {message}
        </Callout>
      ) : null}

      <div className="min-h-48 rounded-lg border border-line bg-surface">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-ink-dim">
            <Spinner /> Loading folders…
          </div>
        ) : !folders?.length ? (
          <p className="p-8 text-center text-sm text-ink-dim">
            No subfolders here. You can save straight into “{current.name}”, or make a new folder
            below.
          </p>
        ) : (
          <ul className="max-h-64 overflow-y-auto p-1">
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  onClick={() => openFolder(folder)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span aria-hidden>📁</span>
                  <span className="truncate">{folder.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextInput
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
            placeholder={`New folder inside "${current.name}"`}
            aria-label="New folder name"
          />
        </div>
        <Button onClick={() => void create()} disabled={!newName.trim() || creating}>
          {creating ? <Spinner /> : null} Create
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
        <p className="min-w-0 truncate text-sm text-ink-dim">
          Saving into <span className="font-medium text-ink">{current.name}</span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSelect(current)}>
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  )
}
