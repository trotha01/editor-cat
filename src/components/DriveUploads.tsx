/**
 * Progress for media currently being copied up to Drive.
 *
 * A failed row stays until dismissed. The bytes are safe in IndexedDB either
 * way, so a failure is worth reporting but never worth interrupting for.
 */
import { Button } from './ui'
import { dismissUpload, useDriveStore } from '../state/useDriveStore'

export function DriveUploads() {
  const uploads = useDriveStore((state) => state.uploads)
  if (uploads.length === 0) return null

  return (
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
            <p className="mt-1 text-red-100">Not backed up — {job.error}</p>
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
  )
}
