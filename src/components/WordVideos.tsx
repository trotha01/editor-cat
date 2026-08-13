/**
 * One word's videos: what has been uploaded for it, in what order, labelled and
 * transcribed.
 *
 * The order is the point of the screen, so it is editable two ways — dragged,
 * which is what anybody reaches for, and with a pair of buttons on each row,
 * which is what works from a keyboard and what a test can press. Both go through
 * the same store action, so neither can drift from the other.
 */
import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AssetThumb } from './AssetThumb'
import { WordSequencePlayer, type PlayableVideo } from './WordSequencePlayer'
import { Button, Callout, EmptyState, Select, Spinner, TextArea } from './ui'
import { useWordVideoBytes } from '../hooks/useWordVideoBytes'
import { toDisplayMessage } from '../lib/errors'
import { ingestBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { ROLES, type Word, type WordVideo, type WordVideoRole } from '../lib/words'
import { useAssetStore } from '../state/useAssetStore'
import { useWordsStore } from '../state/useWordsStore'
import type { Asset } from '../lib/types'

export function WordVideos({ word }: { word: Word }) {
  const catalogue = useAssetStore((state) => state.assets)
  const moveVideo = useWordsStore((state) => state.moveVideo)

  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const byId = useMemo(
    () => new Map(catalogue.map((asset) => [asset.id, asset] as const)),
    [catalogue],
  )

  /**
   * Every video with the file behind it, where there is one.
   *
   * There may not be: the list of videos is kept in this browser and the bytes
   * are cached in it, so a word restored on a machine that has never held the
   * files has rows pointing at nothing. Those are drawn as rows that say so
   * rather than silently dropped — a run of five that shows three is a bug
   * report waiting to happen.
   */
  const entries = useMemo(
    () => word.videos.map((video) => ({ video, asset: byId.get(video.assetId) })),
    [word.videos, byId],
  )

  const playable = useMemo(
    () => entries.filter((entry): entry is PlayableVideo => entry.asset !== undefined),
    [entries],
  )

  // The takes of the word that is open, fetched from Drive if this browser has
  // never held them — which is every take of every word on a second machine.
  const { fetching } = useWordVideoBytes(useMemo(() => playable.map((e) => e.asset), [playable]))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = word.videos.findIndex((video) => video.id === active.id)
    const to = word.videos.findIndex((video) => video.id === over.id)
    if (from >= 0 && to >= 0) moveVideo(word.id, from, to)
  }

  /**
   * Uploads, one file at a time and in the order they were chosen.
   *
   * Sequential on purpose: picking six takes and having them land in whatever
   * order six parallel ingests happened to finish would mean re-ordering the run
   * by hand every time, which is the work this page exists to make easy.
   */
  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    const chosen = Array.from(files)
    setBusy({ done: 0, total: chosen.length })
    setError(null)
    try {
      // Asked for once, before the first byte is read: it is the same folder for
      // every file in this batch, and making it is what stops six uploads
      // racing to create six of it. Null when there is no Drive to make it in,
      // which sends the backup nowhere and the file nowhere but here.
      const driveParentId = (await useWordsStore.getState().ensureWordFolder(word.id)) ?? undefined

      for (const [done, file] of chosen.entries()) {
        setBusy({ done, total: chosen.length })
        if (!file.type.startsWith('video/')) {
          setError(`"${file.name}" is not a video.`)
          continue
        }
        const asset = await ingestBlob(file, { kind: 'video', name: file.name, driveParentId })
        // Into the catalogue but into no project's library: this belongs to a
        // word, not to whatever timeline happens to be open.
        useAssetStore.getState().adopt(asset)
        useWordsStore.getState().addVideo(word.id, asset.id)
      }
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={!!busy}>
          {busy ? <Spinner /> : <span aria-hidden>⬆️</span>}
          {busy ? `Uploading ${busy.done + 1} of ${busy.total}…` : 'Upload videos'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="video/*"
          className="hidden"
          aria-label={`Upload videos for ${word.text}`}
          onChange={(event) => void upload(event.target.files)}
        />
      </div>

      {error ? (
        <Callout tone="error" title="Could not add that file">
          {error}
        </Callout>
      ) : null}

      {/* Keyed on the word so moving to another one starts its run from the
          beginning, rather than resuming at whichever take the last word was
          parked on. */}
      <WordSequencePlayer key={word.id} entries={playable} />

      {entries.length === 0 ? (
        <EmptyState icon="🎥" title="No videos for this word yet">
          Upload the takes for “{word.text}” — an intro, the word itself, an outro — and drag them
          into the order they should play.
        </EmptyState>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={word.videos.map((video) => video.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="flex flex-col gap-2">
              {entries.map((entry, index) => (
                <VideoRow
                  key={entry.video.id}
                  wordId={word.id}
                  video={entry.video}
                  asset={entry.asset}
                  fetching={entry.asset ? fetching.has(entry.asset.id) : false}
                  index={index}
                  count={entries.length}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

function VideoRow({
  wordId,
  video,
  asset,
  fetching,
  index,
  count,
}: {
  wordId: string
  video: WordVideo
  /** Absent when this browser has never heard of the file at all. */
  asset: Asset | undefined
  /** True while its bytes are coming down from Drive. */
  fetching: boolean
  index: number
  count: number
}) {
  const moveVideo = useWordsStore((state) => state.moveVideo)
  const setVideoRole = useWordsStore((state) => state.setVideoRole)
  const setTranscript = useWordsStore((state) => state.setTranscript)
  const removeVideo = useWordsStore((state) => state.removeVideo)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: video.id,
  })

  const name = asset?.name ?? 'this video'

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-col gap-2 rounded-lg border bg-surface p-2 ${
        isDragging ? 'border-accent opacity-80' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${name}`}
          title="Drag to reorder"
          className="cursor-grab rounded-lg px-1.5 py-2 text-ink-dim hover:text-ink"
        >
          <span aria-hidden>⠿</span>
        </button>

        <span className="w-5 shrink-0 pt-2 text-right text-xs text-ink-dim">{index + 1}</span>

        {asset ? (
          <AssetThumb asset={asset} className="w-20 shrink-0" />
        ) : (
          <span className="flex w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-line py-3 text-lg">
            <span aria-hidden>❔</span>
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="flex items-center gap-1.5 text-xs text-ink-dim">
            {fetching ? (
              <>
                <Spinner className="size-3" /> Fetching from Drive…
              </>
            ) : asset ? (
              `${asset.duration ? formatTime(asset.duration) : 'video'}${
                asset.width ? ` · ${asset.width}×${asset.height}` : ''
              }`
            ) : (
              'The file for this one is not on this machine.'
            )}
          </p>
        </div>

        {/* Sized by the box around it rather than by a width on the control:
            the shared `Select` is full-width by design, and a competing width
            utility on it is a coin toss decided by the order Tailwind happens to
            emit the two rules in. */}
        <div className="w-28 shrink-0">
          <Select
            value={video.role}
            aria-label={`Label for ${name}`}
            className="!py-1.5"
            onChange={(event) =>
              setVideoRole(wordId, video.id, event.target.value as WordVideoRole)
            }
          >
            {ROLES.map((role) => (
              <option key={role.id} value={role.id} title={role.hint}>
                {role.label}
              </option>
            ))}
          </Select>
        </div>

        {/* The keyboard's half of the drag, and the discoverable half: a drag
            handle is invisible to anyone who never tries dragging. */}
        <div className="flex shrink-0 flex-col">
          <Button
            variant="ghost"
            className="px-2 py-1"
            disabled={index === 0}
            onClick={() => moveVideo(wordId, index, index - 1)}
            aria-label={`Move ${name} earlier`}
          >
            <span aria-hidden>↑</span>
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1"
            disabled={index === count - 1}
            onClick={() => moveVideo(wordId, index, index + 1)}
            aria-label={`Move ${name} later`}
          >
            <span aria-hidden>↓</span>
          </Button>
        </div>

        <Button
          variant="ghost"
          className="shrink-0"
          onClick={() => void removeVideo(wordId, video.id)}
          aria-label={`Remove ${name}`}
          // Unlike the Library, this does reach Drive — the word's folder is
          // the word's list of takes, so one left in it would come back on the
          // next read. Drive's bin is what makes that recoverable.
          title="Remove this video. The file goes to your Google Drive bin."
        >
          <span aria-hidden>🗑</span>
        </Button>
      </div>

      <TextArea
        rows={2}
        value={video.transcript ?? ''}
        aria-label={`Transcript for ${name}`}
        placeholder="What is said in this video…"
        onChange={(event) => setTranscript(wordId, video.id, event.target.value)}
      />
    </li>
  )
}
