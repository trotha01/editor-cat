/**
 * Clearing out stored files nothing points at any more.
 *
 * Deliberately a button rather than something that happens on its own. Every
 * other repair in this app could be run twice with no consequence; this one
 * deletes media, and the whole safety of it rests on a reference check that has
 * to have succeeded. Something automatic would run that check on a bad
 * connection eventually, and the failure mode is silent.
 *
 * So it says what it found and how much it would free *before* the button, and
 * removes exactly that set — never a freshly computed one. What is on screen is
 * what was agreed to.
 */
import { useEffect, useState } from 'react'
import { Button, Callout } from './ui'
import { sweepUnused, unusedFiles, type SweepSummary, type UnusedFiles } from '../lib/r2/sweep'
import { formatBytes } from '../lib/db'
import { isSupabaseConfigured } from '../lib/supabase/client'

export function StorageSweep() {
  const [found, setFound] = useState<UnusedFiles | null>(null)
  const [summary, setSummary] = useState<SweepSummary | null>(null)
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset when the dialog is reopened, so a summary from last time is not read
  // as this time's answer.
  useEffect(() => () => setFound(null), [])

  if (!isSupabaseConfigured()) return null

  const check = async () => {
    setError(null)
    setSummary(null)
    setChecking(true)
    try {
      setFound(await unusedFiles())
    } catch (cause) {
      // Said out loud, because the alternative reading of a failed check is
      // "nothing to clean up", and that is the one thing it must not mean.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
    }
  }

  const run = async () => {
    if (!found) return
    setError(null)
    setWorking(true)
    try {
      setSummary(await sweepUnused(found))
      setFound(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorking(false)
    }
  }

  const total = found ? found.assets.length + found.strayKeys.length : 0

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div>
        <p className="text-sm font-medium">Unused files in storage</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          Removing a video from a word takes it off the word but leaves the file in storage, in case
          another machine still wants it. This finds the ones nothing points at any more — no
          project, no word, and not a deleted project still inside its ninety days.
        </p>
      </div>

      {error ? <Callout tone="warn">{error}</Callout> : null}

      {found === null ? (
        <div>
          <Button onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking…' : 'Check for unused files'}
          </Button>
        </div>
      ) : total === 0 ? (
        <Callout tone="info">Nothing is unused. Every stored file is still referenced.</Callout>
      ) : (
        <>
          <Callout tone="info">
            {total} file{total === 1 ? '' : 's'} — {formatBytes(found.bytes)} — are not referenced
            by anything.
            {found.strayKeys.length > 0
              ? ` ${found.strayKeys.length} of them have no catalogue entry left at all.`
              : ''}
            {found.assets.length > 0 ? (
              <ul className="mt-1 list-inside list-disc">
                {found.assets.slice(0, 8).map((asset) => (
                  <li key={asset.id}>{asset.name}</li>
                ))}
                {found.assets.length > 8 ? <li>and {found.assets.length - 8} more</li> : null}
              </ul>
            ) : null}
          </Callout>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void run()} disabled={working}>
              {working ? 'Removing…' : `Remove ${total} file${total === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" onClick={() => setFound(null)} disabled={working}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {summary ? (
        <Callout tone="info">
          Removed {summary.objects} file{summary.objects === 1 ? '' : 's'}, freeing about{' '}
          {formatBytes(summary.bytes)}.
        </Callout>
      ) : null}
    </section>
  )
}
