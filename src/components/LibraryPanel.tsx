/**
 * This project's files: everything generated, uploaded or imported for it,
 * ready to drop on the timeline.
 *
 * Only this project's. The bytes are catalogued per browser, so what is listed
 * here is the project's own library list — a file leaves it by being deleted
 * from here and by nothing else, least of all by being taken off the timeline.
 */
import { useMemo, useRef, useState } from 'react'
import { AssetThumb } from './AssetThumb'
import { Button, Callout, EmptyState, Spinner } from './ui'
import { ingestBlob } from '../lib/media'
import { listProjects } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { isAssetOrphaned, libraryAssets } from '../lib/library'
import { formatTime } from '../lib/timeline'
import { useDriveImport } from '../hooks/useDriveImport'
import { useAssetStore } from '../state/useAssetStore'
import { useDriveStore } from '../state/useDriveStore'
import { useProjectStore } from '../state/useProjectStore'
import type { Asset, AssetKind } from '../lib/types'

function kindOf(file: File): AssetKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

export function LibraryPanel({ currentTime = 0 }: { currentTime?: number }) {
  const catalogue = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)
  const removeAsset = useAssetStore((state) => state.remove)
  const project = useProjectStore((state) => state.project)
  const removeFromLibrary = useProjectStore((state) => state.removeFromLibrary)
  const addClip = useProjectStore((state) => state.addClip)
  const addVideoClip = useProjectStore((state) => state.addVideoClip)

  const assets = useMemo(() => libraryAssets(catalogue, project), [catalogue, project])

  const driveReady = useDriveStore((state) => state.status === 'connected' && state.folder !== null)

  const drive = useDriveImport()

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const kind = kindOf(file)
        if (!kind) {
          setError(`"${file.name}" is not an image, video or audio file.`)
          continue
        }
        const asset = await ingestBlob(file, { kind, name: file.name })
        addAsset(asset)
      }
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  /**
   * Takes a file out of this project's library, and out of storage with it —
   * but only if nothing else on this machine still wants the bytes.
   *
   * The same asset can be in more than one project's library: importing a Drive
   * file that is already here adopts the copy rather than fetching a second one.
   * So the catalogue entry only goes when no other project lists the file or
   * uses it, and the copy in the user's Drive is never touched by any of this.
   */
  const forget = async (asset: Asset) => {
    removeFromLibrary(asset.id)
    try {
      // The open project as it is *now*, over whatever is cached for it: its
      // last write may still be in flight, and a stale copy of it would still
      // be listing the file that has just been removed.
      const cached = await listProjects()
      const current = useProjectStore.getState().project
      const projects = [current, ...cached.filter((entry) => entry.id !== current.id)]
      if (isAssetOrphaned(asset.id, projects)) await removeAsset(asset.id)
    } catch {
      // Deliberately silent: the file is out of the library either way, which
      // is the whole of what was asked for. What is left behind is bytes nobody
      // can see, and Settings can still clear those.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          <span aria-hidden>⬆️</span> Upload media
        </Button>
        {driveReady ? (
          <Button onClick={() => void drive.start()} disabled={busy || drive.progress !== null}>
            {drive.progress ? <Spinner /> : <span aria-hidden>📁</span>}{' '}
            {drive.progress
              ? `Importing ${drive.progress.done} of ${drive.progress.total}…`
              : 'Import from Drive'}
          </Button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={(event) => void upload(event.target.files)}
        />
      </div>

      {error ? (
        <Callout tone="error" title="Could not add that file">
          {error}
        </Callout>
      ) : null}

      {drive.error ? (
        <Callout tone="error" title="Import from Drive">
          {drive.error}
        </Callout>
      ) : null}

      {assets.length === 0 ? (
        <EmptyState icon="📁" title="Nothing here yet">
          Generate an image, or upload your own media, and it will collect here.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface p-2"
            >
              <AssetThumb asset={asset} className="w-24 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{asset.name}</p>
                <p className="text-xs text-ink-dim">
                  {asset.kind}
                  {asset.duration ? ` · ${formatTime(asset.duration)}` : ''}
                  {asset.width ? ` · ${asset.width}×${asset.height}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {asset.kind !== 'audio' ? (
                  <>
                    {/* Into the run of clips, after the one the playhead is
                        over. The shot you are parked on is the shot you are
                        working on, so it is where the next one belongs; the end
                        of the track is somewhere you would only have to drag it
                        back from. */}
                    <Button
                      onClick={() => addClip(asset, currentTime)}
                      title="Add to the picture track, after the clip at the playhead"
                    >
                      Add
                    </Button>
                    {/* The other place picture can go. Both of these land at the
                        playhead — that is the moment being aimed at either way —
                        but this one is laid *over* the picture on a track of its
                        own rather than into the run of clips. */}
                    <Button
                      variant="ghost"
                      onClick={() => addVideoClip(asset, currentTime)}
                      title="Lay over the picture at the playhead, on a video track"
                    >
                      Layer
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => void forget(asset)}
                  title="Remove from this project's library. Your Drive copy is left alone."
                  aria-label={`Remove ${asset.name} from the library`}
                >
                  🗑
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
