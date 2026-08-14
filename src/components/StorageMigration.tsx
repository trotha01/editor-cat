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
import {
  countPending,
  migrateDriveToR2,
  type MigrationSummary,
  type PendingCount,
} from '../lib/r2/migrate'
import { connectionStatus } from '../lib/google/connection'
import { connectDrive } from '../lib/auth0/client'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { useAssetStore } from '../state/useAssetStore'

export function StorageMigration() {
  const reloadAssets = useAssetStore((state) => state.load)
  const [connected, setConnected] = useState<boolean | null>(null)

  // A deployment with no Supabase has no asset rows to ask about, so it settles
  // on "nothing to move" without a request. Decided here rather than in the
  // effect below, so there is no render that sets state on its way to the same
  // answer.
  const [count, setCount] = useState<PendingCount | null>(() =>
    isSupabaseConfigured() ? null : { pending: 0, stale: 0, schema: 'ready' },
  )
  const [countError, setCountError] = useState<string | null>(null)
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
    if (!isSupabaseConfigured()) return
    let cancelled = false
    void countPending()
      .then((result) => {
        if (!cancelled) setCount(result)
      })
      .catch((cause: unknown) => {
        // Reported, not swallowed. A count that cannot be taken used to set
        // zero, which reads as "nothing to move" — so the one screen that
        // would have explained why disappeared, and the failure looked like an
        // absent feature.
        if (cancelled) return
        setCount({ pending: 0, stale: 0, schema: 'ready' })
        setCountError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (count === null || connected === null) return null

  const { pending, stale, schema } = count

  // What decides whether this exists is whether there is anything to say, not
  // whether the Drive grant is live. An account with files still up there needs
  // to be told so *especially* when the grant has lapsed — otherwise the screen
  // that would explain it, and offer the reconnect that fixes it, is the screen
  // that hides itself.
  //
  // `drive-id-dropped` is the one state that stays quiet: 0011 has run, which
  // is the intended end of all this, and a permanent warning about a finished
  // job is just noise.
  if (schema === 'drive-id-dropped') return null
  if (pending === 0 && stale === 0 && !summary && !countError) return null

  const run = async () => {
    setError(null)
    setSummary(null)
    try {
      const result = await migrateDriveToR2({ onProgress: setProgress })
      setSummary(result)
      // The catalogue in memory still says these files are only in Drive.
      await reloadAssets()
      setCount(await countPending())
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
            : stale > 0
              ? `${stale} file${stale === 1 ? ' has' : 's have'} already been moved, but this browser does not know where ${stale === 1 ? 'it' : 'they'} went — so ${stale === 1 ? 'it will' : 'they will'} not play here. Nothing needs downloading again; this just brings this machine back into step.`
              : 'Everything has been moved.'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          {/* Said before they press it, not after. Somebody deciding whether to
              spend the bandwidth deserves to know their Drive is left alone. */}
          Nothing is deleted from your Drive. You can stop and start again — it picks up where it
          left off.
        </p>
      </div>

      {countError ? (
        <Callout tone="warn">Could not check what is left to move: {countError}</Callout>
      ) : null}

      {schema === 'missing-r2-key' ? (
        <Callout tone="warn">
          {/* The failure this panel used to hide behind. Named precisely,
              because the fix is one file and the symptom is silence. */}
          Run <code>supabase/migrations/0010_asset_r2_key.sql</code> first. It adds the column this
          records a move into, and until it exists there is nowhere to write the result.
        </Callout>
      ) : connected === false && pending > 0 ? (
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
        (pending > 0 || stale > 0) && (
          <div>
            <Button onClick={() => void run()}>
              {pending > 0 ? (
                <>
                  Move {pending} file{pending === 1 ? '' : 's'}
                </>
              ) : (
                <>
                  Fix {stale} file{stale === 1 ? '' : 's'}
                </>
              )}
            </Button>
          </div>
        )
      )}

      {error ? <Callout tone="warn">{error}</Callout> : null}

      {summary ? (
        <Callout tone={summary.failed.length > 0 ? 'warn' : 'info'}>
          Moved {summary.moved} file{summary.moved === 1 ? '' : 's'}.
          {summary.reconciled > 0
            ? ` Pointed this browser at ${summary.reconciled} more that had already moved.`
            : ''}
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
