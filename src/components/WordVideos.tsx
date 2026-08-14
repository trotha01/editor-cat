/**
 * One word's videos: what has been uploaded for it, in what order, labelled and
 * transcribed.
 *
 * The order is the point of the screen, so it is editable three ways — dragged
 * along the strip in the player above, which is what anybody reaches for,
 * dragged up and down these rows, and with a pair of buttons on each row, which
 * is what works from a keyboard and what a test can press. All three go through
 * the same store action, so none of them can drift from the others.
 *
 * The order is also what most of the labelling is: the ends of a run are its
 * intro and its outro by virtue of being the ends (`roleInRun`), so the only
 * label a row offers is the optional "Word" on the takes in between.
 *
 * Getting the takes here has three doors as well — the upload button, the Drive
 * Picker, and files dragged straight onto this area off the desktop, which is
 * how anyone with a folder of takes open beside the browser would try it first.
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
import { RenameField } from './RenameField'
import { WordSequencePlayer, type PlayableVideo } from './WordSequencePlayer'
import { Button, Callout, EmptyState, Spinner, TextArea } from './ui'
import { useFileDrop } from '../hooks/useFileDrop'
import { useWordVideoBytes } from '../hooks/useWordVideoBytes'
import { formatTime } from '../lib/timeline'
import {
  roleHint,
  roleInRun,
  roleLabel,
  type Word,
  type WordVideo,
  type WordVideoRole,
} from '../lib/words'
import { useAssetStore } from '../state/useAssetStore'
import { useWordsStore } from '../state/useWordsStore'
import type { Asset } from '../lib/types'

export function WordVideos({ word }: { word: Word }) {
  const catalogue = useAssetStore((state) => state.assets)
  const moveVideo = useWordsStore((state) => state.moveVideo)
  const uploading = useWordsStore((state) => state.uploading)
  const uploadError = useWordsStore((state) => state.uploadError)
  const setTranscript = useWordsStore((state) => state.setTranscript)

  /** This word's upload, when the batch that is running is this word's. */
  const busy = uploading?.wordId === word.id ? uploading : null
  /** True while the Picker is open and what came back is being filed. */
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
    () =>
      word.videos.map((video, index) => ({
        video,
        asset: byId.get(video.assetId),
        // Against the whole run, missing files included, so the label a take
        // wears is the same one it wears in the strip above.
        role: roleInRun(video, index, word.videos.length),
      })),
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

  /**
   * A drag, from either place, said in the terms the store speaks.
   *
   * By id rather than by position because the strip above is drawn from the
   * takes whose files this browser holds, and the second of those may be the
   * third of the run — moving "the one I dropped it on" is the only reading that
   * survives that.
   */
  const moveOnto = (activeId: string, overId: string) => {
    const from = word.videos.findIndex((video) => video.id === activeId)
    const to = word.videos.findIndex((video) => video.id === overId)
    if (from >= 0 && to >= 0) moveVideo(word.id, from, to)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    moveOnto(String(active.id), String(over.id))
  }

  /**
   * Files whatever was chosen or dropped, then empties the input.
   *
   * The filing itself is the store's (`addLocalVideos`), because the column
   * beside this one can start the same batch by having files dropped on a word.
   * Clearing the input is this side's: without it, choosing the same file twice
   * in a row is a change event that never fires.
   */
  const upload = async (files: FileList | readonly File[] | null) => {
    if (!files?.length) return
    setError(null)
    await useWordsStore.getState().addLocalVideos(word.id, Array.from(files))
    if (fileInput.current) fileInput.current.value = ''
  }

  // The takes this word's area is dropped on. Off while a batch is running, so
  // a second armful of files cannot be dropped onto one that is still going.
  const { over: dropping, dropProps } = useFileDrop((files) => void upload(files), !!uploading)

  /** Whatever went wrong last, whichever door it came in by. */
  const problem = error ?? uploadError

  return (
    // The whole of a word's area is the target, player and rows included: a
    // folder of takes dragged over here is meant for the word, and asking
    // somebody to hit a particular strip of it would be a worse door than the
    // button. `relative` is for the sheet that covers it while a drag is over.
    <div className="relative flex flex-col gap-3" {...dropProps}>
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

      {/* One place for every door's failures: a file that would not ingest
          reads the same whether it was picked or dropped. */}
      {problem ? (
        <Callout tone="error" title="Could not add that file">
          {problem}
        </Callout>
      ) : null}

      {/* Keyed on the word so moving to another one starts its run from the
          beginning, rather than resuming at whichever take the last word was
          parked on. */}
      <WordSequencePlayer
        key={word.id}
        entries={playable}
        onMove={moveOnto}
        // The same action the box on the take's own row calls, so the transcript
        // under the picture and the one on the row are one thing edited twice
        // over rather than two that have to be kept in step.
        onTranscript={(videoId, transcript) => setTranscript(word.id, videoId, transcript)}
      />

      {entries.length === 0 ? (
        <EmptyState icon="🎥" title="No videos for this word yet">
          Upload the takes for “{word.text}” — an intro, the word itself, an outro — or drag the
          files straight onto this area. Then drag them into the order they should play.
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
            <ol aria-label="Videos in detail" className="flex flex-col gap-2">
              {entries.map((entry, index) => (
                <VideoRow
                  key={entry.video.id}
                  wordId={word.id}
                  video={entry.video}
                  asset={entry.asset}
                  role={entry.role}
                  fetching={entry.asset ? fetching.has(entry.asset.id) : false}
                  index={index}
                  count={entries.length}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Drawn over the area rather than around it, so the whole target is
          visibly one thing however long the run below has grown. It must not
          take pointer events: an overlay that did would be the element the drag
          then leaves and enters, which is a flicker and, on the way out, a drop
          the browser hands to nobody. */}
      {dropping ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-canvas/80">
          <p className="text-sm font-medium">
            <span aria-hidden>⬇️</span> Drop videos to add them to “{word.text}”
          </p>
        </div>
      ) : null}
    </div>
  )
}

function VideoRow({
  wordId,
  video,
  asset,
  role,
  fetching,
  index,
  count,
}: {
  wordId: string
  video: WordVideo
  /** Absent when this browser has never heard of the file at all. */
  asset: Asset | undefined
  /** What it is labelled where it sits. Absent when it is labelled nothing. */
  role: WordVideoRole | undefined
  /** True while its bytes are coming down from Drive. */
  fetching: boolean
  index: number
  count: number
}) {
  const moveVideo = useWordsStore((state) => state.moveVideo)
  const setVideoRole = useWordsStore((state) => state.setVideoRole)
  const setTranscript = useWordsStore((state) => state.setTranscript)
  const removeVideo = useWordsStore((state) => state.removeVideo)
  const renameVideo = useWordsStore((state) => state.renameVideo)

  const [renaming, setRenaming] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: video.id,
  })

  const name = asset?.name ?? 'this video'

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex flex-col gap-2 rounded-lg border bg-surface p-2 ${
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
          {/* The file's own name, and it really is the file's: renaming here
              renames it in Drive too, so what the row says and what the folder
              holds cannot drift apart. Only offered for a take this browser
              knows about — there is no file to rename otherwise. */}
          {renaming && asset ? (
            <RenameField
              initial={asset.name}
              label={`Rename ${name}`}
              onCommit={(next) => renameVideo(asset.id, next)}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <p className="truncate text-sm font-medium">{name}</p>
              {asset ? (
                <Button
                  variant="ghost"
                  className="shrink-0 !px-1 !py-0 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setRenaming(true)}
                  aria-label={`Rename ${name}`}
                >
                  ✏️
                </Button>
              ) : null}
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-ink-dim">
            {fetching ? (
              <>
                <Spinner className="size-3" /> Fetching…
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

        {/* The label, which at the ends of a run is a statement and in the
            middle is a switch: nothing here can make a take the intro except
            putting it first, so the ends are read out rather than offered as a
            choice that would only ever fight with the order. */}
        <div className="w-28 shrink-0">
          {role === 'intro' || role === 'outro' ? (
            <p
              className="rounded-lg bg-surface-2 px-2 py-1.5 text-center text-xs font-medium"
              title={roleHint(role)}
            >
              {roleLabel(role)}
            </p>
          ) : (
            <Button
              variant={role === 'word' ? 'secondary' : 'ghost'}
              className="w-full !py-1.5 text-xs"
              aria-pressed={role === 'word'}
              aria-label={`Label ${name} as the word`}
              title="The takes between the ends may carry this label or none."
              onClick={() => setVideoRole(wordId, video.id, role === 'word' ? undefined : 'word')}
            >
              {roleLabel('word')}
            </Button>
          )}
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
