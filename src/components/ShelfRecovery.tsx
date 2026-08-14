/**
 * Putting back the word takes whose files were only ever in Drive.
 *
 * A sibling of `StorageMigration`, and separate from it because the two repair
 * different damage. That one moves an asset the account knows about; this one
 * is for takes the account has *no asset row for at all*, which the migration
 * could never have found because there was nothing to find.
 *
 * Shown only while something is unreachable, and it counts from the account
 * rather than from this browser — a take with no row is missing on every
 * machine, so a count taken locally would be right by accident.
 *
 * Deliberately not automatic, for the same reason as the migration: it reads
 * every affected file out of Drive and writes it somewhere else, which is a lot
 * of somebody's connection to spend without asking.
 */
import { useEffect, useState } from 'react'
import { Button, Callout } from './ui'
import {
  recoverShelf,
  unreachableWords,
  type RecoverySummary,
  type UnreachableWord,
} from '../lib/r2/recoverShelf'
import { connectionStatus } from '../lib/google/connection'
import { connectDrive } from '../lib/auth0/client'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { useWordsStore } from '../state/useWordsStore'

export function ShelfRecovery() {
  const repairVideo = useWordsStore((state) => state.repairVideo)

  const [words, setWords] = useState<UnreachableWord[] | null>(isSupabaseConfigured() ? null : [])
  const [connected, setConnected] = useState<boolean | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
    current?: string
  } | null>(null)
  const [summary, setSummary] = useState<RecoverySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    void unreachableWords()
      .then((found) => {
        if (!cancelled) setWords(found)
      })
      .catch((cause: unknown) => {
        // Reported rather than swallowed. Zero unreachable takes and a failed
        // question look identical from the outside, and only one of them means
        // there is nothing to do.
        if (cancelled) return
        setWords([])
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (words === null || connected === null) return null
  const takes = words.reduce((sum, word) => sum + word.takes.length, 0)
  if (takes === 0 && !summary && !error) return null

  const run = async () => {
    setError(null)
    setSummary(null)
    try {
      const result = await recoverShelf({
        onProgress: setProgress,
        // Applied as each take lands rather than in one pass at the end: the
        // shelf is written down on every change, so a closed tab keeps what
        // has already been recovered.
        onRepaired: repairVideo,
      })
      setSummary(result)
      setWords(await unreachableWords())
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
        <p className="text-sm font-medium">Recover your word videos</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          {takes > 0
            ? `${takes} take${takes === 1 ? '' : 's'} across ${words.length} word${
                words.length === 1 ? '' : 's'
              } cannot be played on any machine: their files are in your Google Drive but this app never recorded where. It can find them again by their folders and copy them into storage.`
            : 'Every take can be reached.'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          Nothing is deleted from your Drive, and a word whose folder does not match up is left
          exactly as it is rather than guessed at. You can stop and start again.
        </p>
      </div>

      {error ? <Callout tone="warn">{error}</Callout> : null}

      {connected === false && takes > 0 ? (
        <div>
          <Callout tone="warn">
            Reconnect Google Drive so the files can be read. It is asked for once, and this app
            never writes to Drive.
          </Callout>
          <div className="mt-2">
            <Button onClick={() => void connectDrive()}>Reconnect Drive</Button>
          </div>
        </div>
      ) : running ? (
        <div className="text-xs text-ink-dim">
          <p>
            Recovering {progress.done} of {progress.total}
            {progress.current ? ` · ${progress.current}` : ''}
          </p>
          <div
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-label="Recovering your word videos"
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
        takes > 0 && (
          <div>
            <Button onClick={() => void run()}>
              Recover {takes} take{takes === 1 ? '' : 's'}
            </Button>
          </div>
        )
      )}

      {summary ? (
        <Callout tone={summary.words.some((word) => word.skipped) ? 'warn' : 'info'}>
          Recovered {summary.recovered} take{summary.recovered === 1 ? '' : 's'}.
          {/* Per word, not in aggregate: a word left alone needs naming, since
              the reason is usually something only the person can settle — a
              renamed folder, or takes added on one machine and not another. */}
          <ul className="mt-1 list-inside list-disc">
            {summary.words.map((word) => (
              <li key={word.word}>
                {word.word} — {word.skipped ?? `${word.recovered} recovered`}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </section>
  )
}
