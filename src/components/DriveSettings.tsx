/**
 * The Google Drive section of Settings: connect an account, choose the folder
 * new media is saved into, and disconnect again.
 */
import { useState } from 'react'
import { Button, Callout, Spinner } from './ui'
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
  const connect = useDriveStore((state) => state.connect)
  const disconnect = useDriveStore((state) => state.disconnect)
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Google Drive</p>
          <p className="truncate text-xs text-ink-dim">
            {status === 'connected' && account?.email
              ? `Signed in as ${account.email}`
              : 'Save your generated media to a folder you own.'}
          </p>
        </div>

        {status === 'connecting' ? (
          <Spinner />
        ) : status === 'connected' ? (
          <Button variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : (
          <Button onClick={() => void connect()}>
            {status === 'needs-reconnect' ? 'Reconnect' : 'Connect Google Drive'}
          </Button>
        )}
      </div>

      {status === 'needs-reconnect' ? (
        <Callout tone="warn" title="Your Google session expired">
          Media is still saved in this browser. Reconnect to resume backing it up to{' '}
          {folder ? `“${folder.name}”` : 'Drive'}.
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

      {status === 'connected' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas p-2.5">
          <p className="min-w-0 text-xs">
            {folder ? (
              <>
                <span className="text-ink-dim">Saving to</span>{' '}
                <span className="font-medium">📁 {folder.name}</span>
              </>
            ) : (
              <span className="text-ink-dim">
                No folder chosen yet — nothing is being backed up.
              </span>
            )}
          </p>
          <Button onClick={() => setPickerOpen(true)}>
            {folder ? 'Change folder' : 'Choose folder'}
          </Button>
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-dim">
        Files are stored in your own Drive, under your own quota. This site keeps no copy — the
        permission it asks for covers the folder you pick and the files it saves there.
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
