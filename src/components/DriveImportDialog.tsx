/**
 * Browses the media already sitting in the chosen Drive folder and its
 * subfolders, and pulls the selected files into the local library.
 *
 * Import copies the bytes into IndexedDB rather than streaming from Drive on
 * demand. Drive has no URL that both carries our token and serves range
 * requests, so a `<video>` pointed at it could not seek — and export needs the
 * bytes locally anyway (see lib/media.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Callout, EmptyState, Modal, Spinner } from './ui'
import { downloadFile, listMedia, type DriveFile } from '../lib/google/drive'
import { ingestBlob } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { formatBytes } from '../lib/db'
import { useAssetStore } from '../state/useAssetStore'
import { useDriveStore } from '../state/useDriveStore'
import type { AssetKind } from '../lib/types'

const KIND_FILTERS: { id: AssetKind; label: string; icon: string }[] = [
  { id: 'image', label: 'Images', icon: '🖼' },
  { id: 'video', label: 'Video', icon: '🎞' },
  { id: 'audio', label: 'Audio', icon: '🎵' },
]

export function DriveImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Import from Google Drive" wide>
      {/* Mounted only while open so each visit re-reads the folder and starts
          with an empty selection. */}
      {open ? <DriveBrowser onClose={onClose} /> : null}
    </Modal>
  )
}

/** A result tagged with the query that produced it. See DriveFolderPicker. */
interface Loaded<T> {
  forKey: string
  value: T
}

function DriveBrowser({ onClose }: { onClose: () => void }) {
  const folder = useDriveStore((state) => state.folder)
  const assets = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)

  const [kinds, setKinds] = useState<AssetKind[]>(['image'])
  const [result, setResult] = useState<Loaded<DriveFile[]> | null>(null)
  const [error, setError] = useState<Loaded<string> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const folderId = folder?.id ?? ''
  const key = `${folderId}:${[...kinds].sort().join(',')}`

  const files = result?.forKey === key ? result.value : null
  const message = error?.forKey === key ? error.value : null
  const loading = files === null && message === null

  /** Drive ids already in the library, so nothing gets imported twice. */
  const alreadyImported = useMemo(
    () => new Set(assets.map((asset) => asset.driveFileId).filter((id) => id !== undefined)),
    [assets],
  )

  useEffect(() => {
    if (!folderId) return
    let cancelled = false
    listMedia(folderId, { recursive: true, kinds }).then(
      (value) => {
        if (!cancelled) setResult({ forKey: key, value })
      },
      (cause: unknown) => {
        if (!cancelled) setError({ forKey: key, value: toDisplayMessage(cause) })
      },
    )
    return () => {
      cancelled = true
    }
    // `kinds` is state, so its identity changes only when the filter is
    // toggled — which is exactly when this should re-run.
  }, [folderId, kinds, key])

  const toggleKind = (kind: AssetKind) => {
    setKinds((current) =>
      current.includes(kind)
        ? // Never let the filter empty out: an empty query returns everything,
          // which is the opposite of what unticking the last box implies.
          current.length === 1
          ? current
          : current.filter((entry) => entry !== kind)
        : [...current, kind],
    )
  }

  const toggleFile = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const importSelected = async () => {
    const targets = (files ?? []).filter((file) => selected.has(file.id))
    if (targets.length === 0) return

    setImporting({ done: 0, total: targets.length })
    setImportError(null)
    const failures: string[] = []

    for (const [index, file] of targets.entries()) {
      try {
        const blob = await downloadFile(file.id)
        // `driveFileId` marks this as already-in-Drive, which is what stops the
        // upload hook from immediately sending it straight back.
        const asset = await ingestBlob(blob, {
          kind: file.kind,
          name: file.name,
          driveFileId: file.id,
        })
        addAsset(asset)
      } catch (cause) {
        failures.push(`${file.name}: ${toDisplayMessage(cause)}`)
      }
      setImporting({ done: index + 1, total: targets.length })
    }

    setImporting(null)
    setSelected(new Set())

    if (failures.length > 0) {
      setImportError(
        `${failures.length} of ${targets.length} could not be imported. ${failures[0]}`,
      )
      return
    }
    onClose()
  }

  const available = (files ?? []).filter((file) => !alreadyImported.has(file.id)).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-dim">
          Everything in <span className="font-medium text-ink">{folder?.name}</span> and its
          subfolders.
        </p>
        <div className="flex gap-1">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => toggleKind(filter.id)}
              aria-pressed={kinds.includes(filter.id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                kinds.includes(filter.id)
                  ? 'bg-accent text-accent-ink'
                  : 'bg-surface-2 text-ink-dim hover:text-ink'
              }`}
            >
              <span aria-hidden>{filter.icon}</span> {filter.label}
            </button>
          ))}
        </div>
      </div>

      {message ? (
        <Callout tone="error" title="Could not read your folder">
          {message}
        </Callout>
      ) : null}

      {importError ? (
        <Callout tone="error" title="Import problem">
          {importError}
        </Callout>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-10 text-sm text-ink-dim">
          <Spinner /> Searching your folder…
        </div>
      ) : !files?.length ? (
        <EmptyState icon="📂" title="Nothing to import">
          No matching media in “{folder?.name}” or below it. Try another filter, or pick a different
          folder in Settings.
        </EmptyState>
      ) : (
        <ul className="grid max-h-[22rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {files.map((file) => {
            const imported = alreadyImported.has(file.id)
            const isSelected = selected.has(file.id)
            return (
              <li key={file.id}>
                <button
                  type="button"
                  disabled={imported || importing !== null}
                  onClick={() => toggleFile(file.id)}
                  aria-pressed={isSelected}
                  className={`flex w-full flex-col gap-1.5 rounded-lg border p-2 text-left transition disabled:opacity-50 ${
                    isSelected
                      ? 'border-accent bg-accent/10'
                      : 'border-line bg-surface hover:border-ink-dim'
                  }`}
                >
                  <DriveThumb file={file} />
                  <span className="truncate text-xs font-medium">{file.name}</span>
                  <span className="text-[0.7rem] text-ink-dim">
                    {imported
                      ? 'Already in library'
                      : file.size
                        ? formatBytes(file.size)
                        : file.kind}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
        <p className="text-sm text-ink-dim">
          {importing
            ? `Importing ${importing.done} of ${importing.total}…`
            : `${selected.size} selected · ${available} available`}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onClose} disabled={importing !== null}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => void importSelected()}
            disabled={selected.size === 0 || importing !== null}
          >
            {importing ? <Spinner /> : null} Import{selected.size ? ` ${selected.size}` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Drive's thumbnail URLs are short-lived and served from a different host, so
 * they are treated as best-effort decoration: a failure falls back to an icon
 * rather than a broken image.
 */
function DriveThumb({ file }: { file: DriveFile }) {
  const [failed, setFailed] = useState(false)
  const icon = file.kind === 'video' ? '🎞' : file.kind === 'audio' ? '🎵' : '🖼'

  if (!file.thumbnailLink || failed) {
    return (
      <span className="flex aspect-video items-center justify-center rounded-md bg-surface-2 text-2xl">
        <span aria-hidden>{icon}</span>
      </span>
    )
  }

  return (
    <img
      src={file.thumbnailLink}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="aspect-video w-full rounded-md bg-surface-2 object-cover"
    />
  )
}
