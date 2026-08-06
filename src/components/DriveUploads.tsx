/**
 * What Drive is doing right now: media being copied up, and the one thing that
 * can go wrong with the connection after the editor is open.
 *
 * A failed row stays until dismissed. The bytes are safe in IndexedDB either
 * way, so a failure is worth reporting but never worth interrupting for — and it
 * belongs here rather than in Settings, next to the uploads it is about.
 */
import { Button, Callout } from './ui'
import { dismissUpload, useDriveStore } from '../state/useDriveStore'

export function DriveUploads() {
  const uploads = useDriveStore((state) => state.uploads)
  const status = useDriveStore((state) => state.status)

  const lapsed = status === 'needs-reconnect'
  if (uploads.length === 0 && !lapsed) return null

  return (
    <div className="flex flex-col gap-1.5">
      {/* Reached by a grant revoked from the user's Google account page while
          they were working. They keep the editor open — losing the project would
          be far worse — but nothing is reaching Drive until they sign in again,
          and only saying so makes that visible. */}
      {lapsed ? (
        <Callout tone="warn" title="Google access expired">
          New media is still saved in this browser, but nothing is reaching Drive. Sign out and back
          in from Settings to restore it.
        </Callout>
      ) : null}

      <ul className="flex flex-col gap-1.5" aria-label="Google Drive uploads">
        {uploads.map((job) => (
          <li
            key={job.assetId}
            className={`rounded-lg border px-2.5 py-2 text-xs ${
              job.error ? 'border-red-500/35 bg-red-500/10' : 'border-line bg-surface'
            }`}
          >
            <div className="flex items-center gap-2">
              <span aria-hidden>{job.error ? '⚠️' : '☁️'}</span>
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              {job.error ? (
                <Button
                  variant="ghost"
                  className="px-1.5 py-0.5 text-xs"
                  onClick={() => dismissUpload(job.assetId)}
                >
                  Dismiss
                </Button>
              ) : (
                <span className="shrink-0 text-ink-dim">{Math.round(job.progress * 100)}%</span>
              )}
            </div>

            {job.error ? (
              <p className="mt-1 text-red-700">Not backed up — {job.error}</p>
            ) : (
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-valuenow={Math.round(job.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Uploading ${job.name}`}
              >
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.max(2, job.progress * 100)}%` }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
