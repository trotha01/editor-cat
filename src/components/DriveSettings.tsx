/**
 * The Google Drive section of Settings: which folder new media is saved into.
 *
 * There is no connect button here, and deliberately so. Drive is authorised at
 * the sign-in screen along with everything else, so by the time anyone reaches
 * Settings the connection already exists — the only thing left to decide is
 * where the files go.
 */
import { useState } from 'react'
import { Button, Callout } from './ui'
import { DriveFolderPicker } from './DriveFolderPicker'
import { isDriveConfigured } from '../lib/google/gis'
import { useDriveStore } from '../state/useDriveStore'

export function DriveSettings() {
  // Selected field by field rather than destructured off the whole store: an
  // upload in progress updates `uploads` many times a second, and this panel
  // has no reason to re-render for any of them.
  const status = useDriveStore((state) => state.status)
  const account = useDriveStore((state) => state.account)
  const folder = useDriveStore((state) => state.folder)
  const error = useDriveStore((state) => state.error)
  const setFolder = useDriveStore((state) => state.setFolder)
  const clearError = useDriveStore((state) => state.clearError)

  const [pickerOpen, setPickerOpen] = useState(false)

  if (!isDriveConfigured()) {
    return (
      <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <p className="text-sm font-medium">Google Drive</p>
        <p className="text-xs text-ink-dim">
          Not set up for this site. Add a Google OAuth client ID as{' '}
          <code>VITE_GOOGLE_CLIENT_ID</code> at build time to save media to your own Drive. See the
          README for the five-minute version.
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Google Drive</p>
        <p className="truncate text-xs text-ink-dim">
          {account?.email
            ? `Saving to ${account.email}`
            : 'Save your generated media to a folder you own.'}
        </p>
      </div>

      {/* Reached by a grant revoked from the user's Google account page while
          they were working. They keep the editor — throwing someone out of an
          open project would be worse — but nothing is being backed up until
          they sign in again, and only saying so makes that visible. */}
      {status === 'needs-reconnect' ? (
        <Callout tone="warn" title="Your Google access expired">
          Media is still saved in this browser, but nothing is reaching{' '}
          {folder ? `“${folder.name}”` : 'Drive'}. Sign out under Account above and back in to
          restore it.
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="error" title="Google Drive">
          {error}{' '}
          <button type="button" onClick={clearError} className="underline">
            Dismiss
          </button>
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas p-2.5">
        <p className="min-w-0 text-xs">
          {folder ? (
            <>
              <span className="text-ink-dim">Saving to</span>{' '}
              <span className="font-medium">📁 {folder.name}</span>
            </>
          ) : (
            <span className="text-ink-dim">No folder chosen yet — nothing is being backed up.</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {folder ? (
            <Button variant="ghost" onClick={() => setFolder(null)}>
              Stop saving
            </Button>
          ) : null}
          <Button onClick={() => setPickerOpen(true)}>
            {folder ? 'Change folder' : 'Choose folder'}
          </Button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-ink-dim">
        Files are stored in your own Drive, under your own quota. This site keeps no copy — the
        permission you granted when signing in covers the folder you pick and the files it saves
        there.
      </p>

      <DriveFolderPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(chosen) => {
          setFolder(chosen)
          setPickerOpen(false)
        }}
      />
    </section>
  )
}
