/**
 * Moving what is in Drive into our own storage, once.
 *
 * Shown only while there is something to move, so on an account that never used
 * Drive — or one that has already run it — this section does not exist. That is
 * the whole of its lifecycle: it appears, it is pressed, it goes away, and in a
 * later release the code behind it goes with it.
 *
 * Deliberately not automatic. It reads every file the account has and writes
 * every one of them somewhere else, which is a lot of somebody's bandwidth to
 * spend without asking — and on a metered connection, asking is the difference
 * between a helpful app and a rude one.
 */
import { useEffect, useState } from 'react'
import { Button, Callout } from './ui'
import { countPending, migrateDriveToR2, type MigrationSummary } from '../lib/r2/migrate'
import { isR2Configured } from '../lib/r2/client'
import { useDriveStore } from '../state/useDriveStore'
import { useAssetStore } from '../state/useAssetStore'

export function StorageMigration() {
  const driveStatus = useDriveStore((state) => state.status)
  const reloadAssets = useAssetStore((state) => state.load)

  const [pending, setPending] = useState<number | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
    current?: string
  } | null>(null)
  const [summary, setSummary] = useState<MigrationSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const available = isR2Configured() && driveStatus === 'connected'

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void countPending()
      .then((count) => {
        if (!cancelled) setPending(count)
      })
      .catch(() => {
        // Not worth reporting: the section simply does not appear, which is the
        // same thing it does on an account with nothing to move.
        if (!cancelled) setPending(0)
      })
    return () => {
      cancelled = true
    }
  }, [available])

  if (!available || pending === null || (pending === 0 && !summary)) return null

  const run = async () => {
    setError(null)
    setSummary(null)
    try {
      const result = await migrateDriveToR2({ onProgress: setProgress })
      setSummary(result)
      // The catalogue in memory still says these files are only in Drive.
      await reloadAssets()
      setPending(await countPending())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProgress(null)
    }
  }

  const running = progress !== null

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div>
        <p className="text-sm font-medium">Move your media</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          {pending > 0
            ? `${pending} file${pending === 1 ? '' : 's'} still live only in your Google Drive. Moving them here means this app stops needing Drive at all — a new machine can fill a project in without granting Google anything.`
            : 'Everything has been moved.'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          {/* Said before they press it, not after. Somebody deciding whether to
              spend the bandwidth deserves to know their Drive is left alone. */}
          Nothing is deleted from your Drive. You can stop and start again — it picks up where it
          left off.
        </p>
      </div>

      {running ? (
        <div className="text-xs text-ink-dim">
          <p>
            Moving {progress.done} of {progress.total}
            {progress.current ? ` · ${progress.current}` : ''}
          </p>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-label="Moving your media"
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{
                width: `${Math.max(2, (progress.done / Math.max(1, progress.total)) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : (
        pending > 0 && (
          <div>
            <Button onClick={() => void run()}>Move {pending} files</Button>
          </div>
        )
      )}

      {error ? <Callout tone="warn">{error}</Callout> : null}

      {summary ? (
        <Callout tone={summary.failed.length > 0 ? 'warn' : 'info'}>
          Moved {summary.moved} file{summary.moved === 1 ? '' : 's'}.
          {summary.failed.length > 0 ? (
            <>
              {' '}
              {summary.failed.length} could not be moved and{' '}
              {summary.failed.length === 1 ? 'is' : 'are'} still in Drive — press the button again
              to retry {summary.failed.length === 1 ? 'it' : 'them'}.
              <ul className="mt-1 list-inside list-disc">
                {summary.failed.slice(0, 5).map((failure) => (
                  <li key={failure.assetId}>
                    {failure.name} — {failure.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Callout>
      ) : null}
    </section>
  )
}
