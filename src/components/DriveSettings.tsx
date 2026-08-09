/**
 * The Google Drive section of Settings: the folder, and how to change it.
 *
 * Nothing here is about the connection. Drive is granted at the sign-in screen
 * and a folder is chosen before the editor opens, so by the time anyone reaches
 * Settings both already exist — the only thing left is where the files go.
 * Anything that goes wrong with the connection afterwards is reported in the
 * editor, next to the uploads it affects (see DriveUploads).
 *
 * The folder named here is the parent, not the destination: each project gets a
 * folder of its own inside it. Worth saying on screen rather than leaving to be
 * discovered, because it changes what changing it does — new projects go under
 * the new folder, and projects that already have one keep it, so their media
 * stays in one piece.
 */
import { useState } from 'react'
import { Button, Callout } from './ui'
import { isPickerConfigured, pickFolder } from '../lib/google/picker'
import { toDisplayMessage } from '../lib/errors'
import { useDriveStore } from '../state/useDriveStore'

export function DriveSettings() {
  const folder = useDriveStore((state) => state.folder)
  const setFolder = useDriveStore((state) => state.setFolder)

  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)

  // No folder means the gate has not finished with them yet, and no Picker means
  // there is nothing here to offer: the folder cannot be changed without one.
  if (!folder || !isPickerConfigured()) return null

  const change = async () => {
    setChoosing(true)
    setError(null)
    try {
      const chosen = await pickFolder()
      if (chosen) setFolder(chosen)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setChoosing(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Google Drive folder</p>
          <p className="truncate text-xs text-ink-dim">
            <span aria-hidden>📁</span> {folder.name}
          </p>
        </div>
        <Button onClick={() => void change()} disabled={choosing}>
          Change folder
        </Button>
      </div>

      <p className="text-xs text-ink-dim">
        New projects get a folder of their own in here, named after the project. Changing this moves
        where the next one goes; projects that already have a folder keep it, so their media stays
        together.
      </p>

      {error ? (
        <Callout tone="error" title="Could not change folder">
          {error}
        </Callout>
      ) : null}
    </section>
  )
}
