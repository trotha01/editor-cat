/** Everything generated or uploaded, ready to drop on the timeline. */
import { useRef, useState } from 'react'
import { AssetThumb } from './AssetThumb'
import { Button, Callout, EmptyState } from './ui'
import { ingestBlob } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { formatTime } from '../lib/timeline'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import type { AssetKind } from '../lib/types'

function kindOf(file: File): AssetKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

export function LibraryPanel() {
  const assets = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)
  const removeAsset = useAssetStore((state) => state.remove)
  const addClip = useProjectStore((state) => state.addClip)

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          <span aria-hidden>⬆️</span> Upload media
        </Button>
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
                  <Button onClick={() => addClip(asset)} title="Add to the end of the timeline">
                    Add
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => void removeAsset(asset.id)}
                  title="Delete from your library"
                  aria-label={`Delete ${asset.name}`}
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
