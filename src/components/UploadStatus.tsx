/**
 * What is still on its way to storage, and what did not get there.
 *
 * The bytes are in IndexedDB either way, so this never interrupts and never
 * blocks an edit — that is the "local first, cloud second" rule the sync
 * scheduler is built around. But it is more insistent than the Drive version it
 * sits beside, and deliberately so: Drive was a *second* backup, so a failure
 * there cost redundancy and nothing else. Once Drive is gone this is the only
 * copy besides this browser's, and "not backed up" stops being a footnote and
 * starts being the difference between a slow morning and lost work.
 *
 * A failed row therefore offers to try again rather than only to be dismissed.
 */
import { Button, Callout } from './ui'
import { useR2Store } from '../state/useR2Store'

export function UploadStatus() {
  const uploads = useR2Store((state) => state.uploads)
  const failed = useR2Store((state) => state.failed)
  const retryFailed = useR2Store((state) => state.retryFailed)
  const clearFailed = useR2Store((state) => state.clearFailed)

  if (uploads.length === 0 && failed.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      {failed.length > 0 ? (
        <Callout tone="warn" title="Not backed up">
          {failed.length === 1 ? 'One file is' : `${failed.length} files are`} saved in this browser
          but have not reached storage. Clearing this site&rsquo;s data would lose them.
          <div className="mt-2">
            <Button variant="ghost" className="px-1.5 py-0.5 text-xs" onClick={retryFailed}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : null}

      <ul className="flex flex-col gap-1.5" aria-label="Media backup">
        {uploads.map((job) => (
          <li
            key={job.assetId}
            className="rounded-lg border border-line bg-surface px-2.5 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden>☁️</span>
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              <span className="shrink-0 text-ink-dim">
                {/* Only once it is more than the first go. Saying "attempt 1 of
                    3" on every upload would make an ordinary save look fragile. */}
                {job.attempt > 1 ? `retrying (${job.attempt}/3)` : 'saving…'}
              </span>
            </div>
          </li>
        ))}

        {failed.map((job) => (
          <li
            key={job.assetId}
            className="rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden>⚠️</span>
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              <Button
                variant="ghost"
                className="px-1.5 py-0.5 text-xs"
                onClick={() => clearFailed(job.assetId)}
              >
                Dismiss
              </Button>
            </div>
            {job.error ? <p className="mt-1 text-red-700">{job.error}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
