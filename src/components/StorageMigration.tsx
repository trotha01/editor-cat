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
import { connectionStatus } from '../lib/google/connection'
import { connectDrive } from '../lib/auth0/client'
import { useAssetStore } from '../state/useAssetStore'

export function StorageMigration() {
  const reloadAssets = useAssetStore((state) => state.load)
  const [connected, setConnected] = useState<boolean | null>(null)

  const [pending, setPending] = useState<number | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
    current?: string
  } | null>(null)
  const [summary, setSummary] = useState<MigrationSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Asked rather than read off a store, because the Drive store went with the
  // rest of the integration. This is the last thing in the app that cares
  // whether there is a Google grant, and it cares for exactly as long as
  // somebody still has files up there.
  useEffect(() => {
    let cancelled = false
    void connectionStatus()
      .then((status) => {
        if (!cancelled) setConnected(status.connected)
      })
      .catch(() => {
        if (!cancelled) setConnected(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
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
  }, [])

  // The count is what decides whether this exists, not the Drive grant. An
  // account with files still up there needs to be told so even when the grant
  // has lapsed — otherwise the one screen that would explain what is left, and
  // offer the reconnect that fixes it, is the screen that hides itself.
  if (pending === null || connected === null || (pending === 0 && !summary)) return null

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

      {connected === false ? (
        <div>
          <Callout tone="warn">
            Reconnect Google Drive to move these across. It is asked for once, to read the files,
            and this app never writes to Drive again.
          </Callout>
          <div className="mt-2">
            <Button onClick={() => void connectDrive()}>Reconnect Drive</Button>
          </div>
        </div>
      ) : running ? (
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
            <Button onClick={() => void run()}>
              Move {pending} file{pending === 1 ? '' : 's'}
            </Button>
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
