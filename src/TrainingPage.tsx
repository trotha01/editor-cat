/**
 * The training uploader: a few hundred photos, a set name, and nothing else.
 *
 * A third page rather than a panel in the editor, for the same reason the word
 * pages are one: it is a different job with a different lifetime. The editor is
 * one project being cut together and the word shelf is a growing library, while
 * this is a bulk errand — pick a folder, watch four hundred photos go up, hand
 * the set to a trainer, and come back weeks later for the next LoRA. Nothing it
 * uploads is a clip, a take or an asset, so nothing it uploads is catalogued:
 * see Root.tsx, where this page sits deliberately outside the ingest hook that
 * backs up and records everything else the app makes.
 *
 * The whole of the interesting behaviour is that it is **resumable**. Four
 * hundred photos is fifteen to forty minutes on a domestic connection, which is
 * long enough that some of them will be interrupted — a closed laptop, a dropped
 * connection, a browser that decided to reload. So the page asks the bucket what
 * the set already holds, names files as a pure function of what they are called
 * (lib/training/names.ts), and skips anything already there. Picking the same
 * folder again after an interruption uploads only what is missing.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FeedbackBubble } from './components/FeedbackBubble'
import { SettingsDialog } from './components/SettingsDialog'
import { Button, Callout, EmptyState, Field, LinkButton, Spinner, TextInput } from './components/ui'
import { useFileDrop } from './hooks/useFileDrop'
import { usePersistedState } from './hooks/usePersistedState'
import { EDITOR_HASH, WORDS_HASH } from './lib/route'
import { StorageUnconfiguredError } from './lib/r2/upload'
import { isSetId, nameSelection, toSetId } from './lib/training/names'
import { isAbort, listTrainingSet, uploadTrainingSet, type ItemState } from './lib/training/upload'

/**
 * What a LoRA is usually trained on, and the only number this page has an
 * opinion about. Shown rather than enforced: a subject with forty good photos
 * trains better than one with four hundred bad ones, and the page has no way of
 * telling which it is looking at.
 */
const TYPICAL_MIN = 200
const TYPICAL_MAX = 400

/** Where a status update lives until the next flush. See `pushStatus`. */
interface Status {
  state: ItemState
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Two files are the same pick if the browser says all three of these match. */
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

const STATE_LABELS: Record<ItemState, string> = {
  queued: 'Waiting',
  uploading: 'Uploading…',
  done: 'Uploaded',
  skipped: 'Already in the set',
  failed: 'Failed',
}

const STATE_STYLES: Record<ItemState, string> = {
  queued: 'text-ink-dim',
  uploading: 'text-accent',
  done: 'text-emerald-700',
  skipped: 'text-ink-dim',
  failed: 'text-red-700',
}

export function TrainingPage() {
  /**
   * Which folder in the bucket this is. Remembered, because the same set is
   * usually added to over several sittings — and because retyping it wrongly
   * after an interruption would start a second set rather than finish the first.
   */
  const [setId, setSetId] = usePersistedState('editor-cat.training.setId.v1', 'lora-1')
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** The files picked, before any naming: the source of truth for the list. */
  const [selection, setSelection] = useState<File[]>([])
  const [status, setStatus] = useState<Record<string, Status>>({})

  /**
   * What the bucket already holds, and which set that was an answer about.
   *
   * The set name is carried alongside the names rather than being implied by
   * when the listing arrived. Retyping the name is how you move to another set,
   * and a listing left over from the previous one would mark rows "already in
   * the set" for a set that has never seen them — the one wrong answer here
   * that silently uploads nothing.
   */
  const [listed, setListed] = useState<{ setId: string; names: Set<string> } | null>(null)
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [unconfigured, setUnconfigured] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const photoInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Set through the DOM rather than as JSX props: these two are non-standard
    // (and `webkitdirectory` is the only way to offer "choose a folder", which
    // is how a camera roll of four hundred photos is actually picked). React
    // would pass them through, but not in a way TypeScript agrees with.
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
  }, [])

  const { named, rejected } = useMemo(() => nameSelection(selection), [selection])

  /** The listing, but only while it is still about the set on screen. */
  const already = listed?.setId === setId ? listed.names : null

  /**
   * Status updates, batched.
   *
   * The uploader reports every file as it starts and finishes, which over four
   * hundred photos is more than a thousand callbacks — and each one re-renders a
   * list of four hundred rows. Collecting them and flushing on a timer turns
   * that into eight or nine renders a second, which looks identical and costs
   * nothing.
   */
  const queued = useRef<Record<string, Status>>({})
  const flush = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (flush.current !== null) window.clearTimeout(flush.current)
      abort.current?.abort()
    }
  }, [])

  const pushStatus = (name: string, next: Status) => {
    queued.current[name] = next
    if (flush.current !== null) return
    flush.current = window.setTimeout(() => {
      flush.current = null
      const batch = queued.current
      queued.current = {}
      setStatus((current) => ({ ...current, ...batch }))
    }, 120)
  }

  /**
   * Ask the bucket what this set holds.
   *
   * Debounced, because the set name is a text field somebody types into and
   * every keystroke would otherwise be a listing of a set that does not exist.
   */
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (!isSetId(setId)) return

      setListing(true)
      setListError(null)
      listTrainingSet(setId, controller.signal)
        .then((names) => setListed({ setId, names: new Set(names) }))
        .catch((error: unknown) => {
          if (isAbort(error)) return
          if (error instanceof StorageUnconfiguredError) {
            setUnconfigured(error.message)
            setListed({ setId, names: new Set() })
            return
          }
          // Not fatal: an upload can still be attempted, it just cannot skip
          // what is already there. Said out loud rather than swallowed, because
          // "0 already in this set" would otherwise be a confident lie.
          setListError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => setListing(false))
    }, 500)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [setId])

  const addFiles = (files: File[]) => {
    setRunError(null)
    setSelection((current) => {
      const seen = new Set(current.map(fileKey))
      // Dropping the same folder twice is a thing people do when they are not
      // sure the first one took, so the same file picked twice is one file here.
      const additions = files.filter((file) => !seen.has(fileKey(file)))
      return additions.length > 0 ? [...current, ...additions] : current
    })
  }

  const { over, dropProps } = useFileDrop(addFiles, running)

  /**
   * What a row says it is.
   *
   * A file the bucket already holds reads as skipped before any run starts,
   * rather than waiting for the uploader to say so: somebody who re-picked a
   * folder to finish an interrupted upload wants to see straight away that only
   * eleven of the four hundred are still to go.
   */
  const stateOf = (name: string): ItemState =>
    status[name]?.state ?? (already?.has(name) ? 'skipped' : 'queued')

  const counts = useMemo(() => {
    const tally: Record<ItemState, number> = {
      queued: 0,
      uploading: 0,
      done: 0,
      skipped: 0,
      failed: 0,
    }
    for (const entry of named) tally[stateOf(entry.name)] += 1
    return tally
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateOf is these two
  }, [named, status, already])

  const totalBytes = useMemo(() => named.reduce((sum, entry) => sum + entry.file.size, 0), [named])

  /** Everything not already in the set — what a run would send. */
  const outstanding = named.filter((entry) => {
    const state = stateOf(entry.name)
    return state !== 'done' && state !== 'skipped'
  })

  const start = async (only?: Set<string>) => {
    if (!isSetId(setId)) {
      setRunError('Give the set a name first.')
      return
    }

    const files = only ? named.filter((entry) => only.has(entry.name)) : outstanding
    if (files.length === 0) return

    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setRunError(null)

    // A retry is a fresh attempt at these files, so whatever the bucket said
    // when the page loaded is no longer the reason to skip them.
    const skipList = only ? undefined : (already ?? undefined)

    try {
      const result = await uploadTrainingSet({
        setId,
        files,
        ...(skipList ? { already: skipList } : {}),
        onItem: (progress) =>
          pushStatus(progress.name, {
            state: progress.state,
            ...(progress.error ? { error: progress.error } : {}),
          }),
        signal: controller.signal,
      })

      // Fold what just landed into what the set holds, rather than listing it
      // again: the answer is known, and a second listing of four hundred objects
      // is a slow way to be told what we watched happen.
      setListed((current) => {
        const next = new Set(current?.setId === setId ? current.names : [])
        for (const entry of files) {
          if (!result.failed.some((failure) => failure.name === entry.name)) next.add(entry.name)
        }
        return { setId, names: next }
      })

      if (result.failed.length > 0) {
        setRunError(
          `${result.failed.length} file${result.failed.length === 1 ? '' : 's'} did not upload. ` +
            'Retry failed sends only those.',
        )
      }
    } catch (error) {
      if (isAbort(error)) {
        setRunError('Stopped. What had already uploaded is in the set.')
      } else if (error instanceof StorageUnconfiguredError) {
        setUnconfigured(error.message)
      } else {
        setRunError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      abort.current = null
      setRunning(false)
    }
  }

  const retryFailed = () => {
    const failed = new Set(
      named.filter((entry) => status[entry.name]?.state === 'failed').map((entry) => entry.name),
    )
    if (failed.size > 0) void start(failed)
  }

  const clearList = () => {
    setSelection([])
    setStatus({})
    queued.current = {}
    setRunError(null)
  }

  /**
   * How many photos the set holds, counting what this sitting has just added.
   *
   * A union rather than a sum: a run folds what it uploaded into the listing
   * when it finishes, so `already.size + done` counts every photo of that run
   * twice — and a training set is a page you come back to, so the number it
   * reports is the number somebody decides on.
   */
  const inSet = useMemo(() => {
    const total = new Set(already ?? [])
    for (const entry of named) {
      if (stateOf(entry.name) === 'done') total.add(entry.name)
    }
    return total.size
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stateOf is these two
  }, [already, named, status])
  const setIdValid = isSetId(setId)

  return (
    <div
      className="flex h-full flex-col bg-canvas text-ink"
      // A page whose whole job is taking dropped files is a page people will
      // drop files *near*. Anything that misses the zone is swallowed here, or
      // the browser navigates away from the app to the photo that was dropped.
      onDragOver={(event) => {
        if (event.defaultPrevented) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'none'
      }}
      onDrop={(event) => event.preventDefault()}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span aria-hidden className="text-xl">
          🧠
        </span>
        <h1 className="text-sm font-semibold">Training photos</h1>
        <p role="status" className="min-w-0 flex-1 truncate text-xs text-ink-dim">
          {running
            ? `Uploading… ${counts.done} of ${counts.done + counts.queued + counts.uploading} sent`
            : 'Upload the photos for a LoRA training set.'}
        </p>
        {running || listing ? <Spinner className="text-ink-dim" /> : null}

        <LinkButton href={EDITOR_HASH}>
          <span aria-hidden>🎬</span> Editor
        </LinkButton>
        <LinkButton href={WORDS_HASH}>
          <span aria-hidden>🔤</span> Words
        </LinkButton>
        {/* Last here as it is on both other pages, so it stays findable by
            position rather than by reading the header each time. */}
        <Button onClick={() => setSettingsOpen(true)}>
          <span aria-hidden>⚙️</span> Settings
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {unconfigured ? (
          <Callout tone="warn" title="This site has nowhere to put training sets">
            {unconfigured} Everything else in the app is unaffected — the training bucket is its own
            setting.
          </Callout>
        ) : null}

        <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <Field
            label="Set name"
            htmlFor="training-set"
            hint={
              setIdValid ? (
                <>
                  The photos land in <code>set/&lt;your account&gt;/{setId}/</code>. One set per
                  LoRA: name it after what you are training.
                </>
              ) : (
                'Letters, numbers, dashes and underscores.'
              )
            }
          >
            <TextInput
              id="training-set"
              value={setId}
              disabled={running}
              placeholder="my-cat-lora"
              // Corrected as it is typed rather than refused on submit: the
              // endpoint will not store a set name with a space in it, and
              // finding that out four hundred photos later would be a poor way
              // to be told.
              onChange={(event) => setSetId(toSetId(event.target.value))}
            />
          </Field>

          <p className="text-xs text-ink-dim">
            {listing ? (
              'Checking what is already in this set…'
            ) : listError ? (
              <span className="text-amber-800">
                Could not check what is already in this set ({listError}). Uploading still works —
                photos already there will simply be written again.
              </span>
            ) : already === null ? (
              'Name a set to see what is already in it.'
            ) : (
              <>
                <strong className="font-semibold text-ink">{inSet}</strong> photo
                {inSet === 1 ? '' : 's'} in this set.{' '}
                {inSet < TYPICAL_MIN
                  ? `A LoRA usually wants ${TYPICAL_MIN}–${TYPICAL_MAX}.`
                  : inSet > TYPICAL_MAX
                    ? `That is past the ${TYPICAL_MAX} a LoRA usually wants, which is fine — it just trains for longer.`
                    : 'That is the range a LoRA usually wants.'}
              </>
            )}
          </p>
        </section>

        <section
          {...dropProps}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
            over ? 'border-accent bg-accent/10' : 'border-line bg-surface'
          }`}
        >
          <span aria-hidden className="text-3xl">
            🖼️
          </span>
          <p className="text-sm font-medium">Drop photos here</p>
          <p className="max-w-md text-xs leading-relaxed text-ink-dim">
            JPEG, PNG, WebP, HEIC, AVIF and TIFF, and MP4, WebM or MOV if you are pulling frames out
            of a clip later. Nothing is resized or re-encoded — the photos arrive in the bucket
            exactly as they left here.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              disabled={running}
              onClick={() => photoInput.current?.click()}
            >
              Choose photos
            </Button>
            <Button disabled={running} onClick={() => folderInput.current?.click()}>
              Choose a folder
            </Button>
          </div>
          <input
            ref={photoInput}
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])])
              // Cleared so that picking the same folder again — the whole of how
              // an interrupted upload is resumed — still fires a change event.
              event.target.value = ''
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
        </section>

        {rejected.length > 0 ? (
          <Callout
            tone="warn"
            title={`${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped`}
          >
            {rejected
              .slice(0, 5)
              .map((entry) => entry.file.name)
              .join(', ')}
            {rejected.length > 5 ? `, and ${rejected.length - 5} more` : ''} — not a photo or video
            this set stores.
          </Callout>
        ) : null}

        {runError ? <Callout tone="error">{runError}</Callout> : null}

        {named.length === 0 ? (
          <EmptyState icon="📂" title="Nothing picked yet">
            Choose a folder of photos, or drop them above. They upload straight to storage from this
            browser — nothing passes through the site.
          </EmptyState>
        ) : (
          <>
            <section className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
              <p className="min-w-0 flex-1 text-sm">
                <strong className="font-semibold">{named.length}</strong> picked ·{' '}
                {formatBytes(totalBytes)}
                {counts.done > 0 ? ` · ${counts.done} uploaded` : ''}
                {counts.skipped > 0 ? ` · ${counts.skipped} already there` : ''}
                {counts.failed > 0 ? (
                  <span className="text-red-700"> · {counts.failed} failed</span>
                ) : null}
              </p>

              {running ? (
                <Button variant="danger" onClick={() => abort.current?.abort()}>
                  Stop
                </Button>
              ) : (
                <>
                  {counts.failed > 0 ? <Button onClick={retryFailed}>Retry failed</Button> : null}
                  <Button onClick={clearList}>Clear list</Button>
                  <Button
                    variant="primary"
                    disabled={!setIdValid || outstanding.length === 0}
                    onClick={() => void start()}
                  >
                    {/* "Upload 0 files" is what a finished set would otherwise
                        say, which reads as a button that failed rather than as
                        a job that is done. */}
                    {outstanding.length === 0
                      ? 'Nothing left to send'
                      : `Upload ${outstanding.length} file${outstanding.length === 1 ? '' : 's'}`}
                  </Button>
                </>
              )}
            </section>

            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {named.map((entry) => {
                const state = stateOf(entry.name)
                const error = status[entry.name]?.error
                return (
                  <li
                    key={entry.name}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate" title={entry.file.name}>
                      {entry.name}
                      {/* Only when the two differ, which is the case worth
                          seeing: a name was rewritten to something the bucket
                          will take, and the person looking for the photo later
                          needs to know which one it became. */}
                      {entry.name !== entry.file.name ? (
                        <span className="text-ink-dim"> ← {entry.file.name}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-ink-dim">
                      {formatBytes(entry.file.size)}
                    </span>
                    <span className={`shrink-0 text-xs ${STATE_STYLES[state]}`}>
                      {STATE_LABELS[state]}
                    </span>
                    {error ? (
                      <span className="w-full text-xs text-red-700 [overflow-wrap:anywhere]">
                        {error}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </main>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <FeedbackBubble />
    </div>
  )
}
