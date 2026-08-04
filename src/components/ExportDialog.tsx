/** Renders the timeline to an MP4 in the browser. */
import { useRef, useState } from 'react'
import { Button, Callout, Field, Modal, Select, Spinner } from './ui'
import {
  renderProject,
  type ExportAsset,
  type RenderProgress,
  type RenderRequest,
} from '../lib/export/render'
import { getBlob } from '../lib/db'
import { downloadBlob } from '../lib/media'
import { clipDuration, formatTime, layoutClips } from '../lib/timeline'
import { audioEnd, gainFor } from '../lib/audioTracks'
import { formatBytes } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'

const QUALITY = [
  { crf: 28, label: 'Smaller file' },
  { crf: 23, label: 'Balanced' },
  { crf: 18, label: 'Best quality' },
]

const RESOLUTIONS = [
  { width: 854, height: 480, label: '480p' },
  { width: 1280, height: 720, label: '720p' },
  { width: 1920, height: 1080, label: '1080p' },
]

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useProjectStore((state) => state.project)
  const setResolution = useProjectStore((state) => state.setResolution)
  const assets = useAssetStore((state) => state.assets)

  const [crf, setCrf] = useState(23)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Blob | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const positioned = layoutClips(project.clips)
  const visualDuration = positioned.at(-1)?.end ?? 0
  const outputDuration = Math.max(visualDuration, audioEnd(project.audioClips))

  // Muted tracks are dropped rather than exported at zero gain: encoding
  // silence costs time and gains nothing.
  const audibleClips = project.audioClips.filter((clip) => gainFor(project.audioTracks, clip) > 0)
  const mutedCount = project.audioClips.length - audibleClips.length

  const run = async () => {
    setError(null)
    setResult(null)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      // Gather every blob the render needs up front, so a missing asset fails
      // before the encoder has spent a minute of the user's time.
      const needed = new Map<string, ExportAsset>()
      const collect = async (assetId: string) => {
        if (needed.has(assetId)) return
        const asset = assets.find((entry) => entry.id === assetId)
        if (!asset) throw new Error('One of the clips refers to media that is no longer available.')
        const blob = await getBlob(asset.blobKey)
        if (!blob) {
          throw new Error(
            `"${asset.name}" is no longer stored locally, so it cannot be included in the export.`,
          )
        }
        needed.set(assetId, { id: assetId, blob, mimeType: asset.mimeType })
      }

      for (const clip of project.clips) await collect(clip.assetId)

      const audio: RenderRequest['audio'] = []
      for (const clip of audibleClips) {
        const assetId =
          clip.useConverted && clip.convertedAssetId ? clip.convertedAssetId : clip.assetId
        await collect(assetId)
        audio.push({
          assetId,
          startTime: clip.startTime,
          inPoint: clip.inPoint,
          duration: clip.duration,
          volume: gainFor(project.audioTracks, clip),
        })
      }

      const clips = project.clips.map((clip) => {
        const asset = assets.find((entry) => entry.id === clip.assetId)
        return {
          assetId: clip.assetId,
          kind: (asset?.kind === 'video' ? 'video' : 'image') as 'video' | 'image',
          inPoint: clip.inPoint,
          duration: clipDuration(clip),
        }
      })

      const { blob } = await renderProject(
        {
          clips,
          audio,
          assets: needed,
          width: project.width,
          height: project.height,
          fps: project.fps,
          crf,
        },
        { onProgress: setProgress, signal: controller.signal },
      )

      setResult(blob)
      downloadBlob(blob, `${project.name.replace(/[^\w -]/g, '') || 'export'}.mp4`)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const busy = progress !== null

  return (
    <Modal open={open} onClose={onClose} title="Export video" wide>
      <div className="flex flex-col gap-4">
        {project.clips.length === 0 ? (
          <Callout tone="warn">Add at least one clip to the timeline before exporting.</Callout>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Resolution">
            <Select
              value={`${project.width}x${project.height}`}
              disabled={busy}
              onChange={(event) => {
                const found = RESOLUTIONS.find(
                  (option) => `${option.width}x${option.height}` === event.target.value,
                )
                if (found) setResolution(found.width, found.height)
              }}
            >
              {RESOLUTIONS.map((option) => (
                <option key={option.label} value={`${option.width}x${option.height}`}>
                  {option.label} ({option.width}×{option.height})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Quality">
            <Select
              value={crf}
              disabled={busy}
              onChange={(event) => setCrf(Number(event.target.value))}
            >
              {QUALITY.map((option) => (
                <option key={option.crf} value={option.crf}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Callout tone="info" title="Everything happens on your machine">
          Rendering runs in this tab with ffmpeg compiled to WebAssembly — your media is never
          uploaded. That also means it uses your CPU: expect roughly a minute for a short project,
          and keep this tab in the foreground.
        </Callout>

        <p className="text-sm text-ink-dim">
          {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} ·{' '}
          {formatTime(outputDuration)} ·{' '}
          {audibleClips.length > 0
            ? `${audibleClips.length} audio clip${audibleClips.length === 1 ? '' : 's'} across ` +
              `${new Set(audibleClips.map((clip) => clip.trackId)).size} track` +
              `${new Set(audibleClips.map((clip) => clip.trackId)).size === 1 ? '' : 's'}` +
              (mutedCount > 0 ? ` · ${mutedCount} muted, not exported` : '')
            : 'no audio'}
        </p>

        {progress ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Spinner />
              <span>{progress.message}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round((progress.ratio ?? 0) * 100)}%` }}
              />
            </div>
            <Button
              variant="ghost"
              className="self-start"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel export
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={run} disabled={project.clips.length === 0}>
              <span aria-hidden>⬇️</span> Render and download MP4
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {error ? (
          <Callout tone="error" title="Export failed">
            <pre className="mt-1 max-h-40 overflow-auto text-xs whitespace-pre-wrap">{error}</pre>
          </Callout>
        ) : null}

        {result ? (
          <Callout tone="success" title="Done">
            Exported {formatBytes(result.size)}. The download should have started — if your browser
            blocked it,{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => downloadBlob(result, `${project.name || 'export'}.mp4`)}
            >
              save it again
            </button>
            .
          </Callout>
        ) : null}
      </div>
    </Modal>
  )
}
