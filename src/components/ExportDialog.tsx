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
import { clipGain, formatTime, layoutClips, leadInOf } from '../lib/timeline'
import { audioEnd, gainFor } from '../lib/audioTracks'
import { layerGain, opacityFor, videoClipsOf, videoTracksOf } from '../lib/videoTracks'
import { captionCuesOf, captionTracksOf } from '../lib/captions'
import { buildAssFile } from '../lib/export/assCaptions'
import { captionFonts } from '../lib/export/captionFonts'
import { formatBytes } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { exportPresetsFor, orientationOf, type ExportPreset } from '../lib/orientation'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'

const QUALITY = [
  { crf: 28, label: 'Smaller file' },
  { crf: 23, label: 'Balanced' },
  { crf: 18, label: 'Best quality' },
]

/**
 * The presets offered follow the project's orientation, so only three of the
 * six are ever shown. A project sitting on a size that matches none of them —
 * square, or something set before the presets changed — would otherwise leave
 * the Select with a value not among its options, which React warns about and
 * renders blank, so its current size is appended as its own option.
 */
function resolutionOptions(width: number, height: number): ExportPreset[] {
  const presets = exportPresetsFor(orientationOf(width, height))
  if (presets.some((preset) => preset.width === width && preset.height === height)) return presets
  return [
    ...presets,
    { label: 'Current', orientation: orientationOf(width, height), width, height },
  ]
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useProjectStore((state) => state.project)
  const setResolution = useProjectStore((state) => state.setResolution)
  const assets = useAssetStore((state) => state.assets)

  const [crf, setCrf] = useState(23)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Blob | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const resolutions = resolutionOptions(project.width, project.height)
  const leadIn = leadInOf(project)
  // Positions already carry the lead-in, so the last clip's end is where the
  // picture really finishes rather than how long it runs for.
  const positioned = layoutClips(project.clips, leadIn)
  const visualDuration = positioned.at(-1)?.end ?? 0
  const outputDuration = Math.max(visualDuration, audioEnd(project.audioClips))

  // Muted tracks are dropped rather than exported at zero gain: encoding
  // silence costs time and gains nothing.
  const audibleClips = project.audioClips.filter((clip) => gainFor(project.audioTracks, clip) > 0)
  const mutedCount = project.audioClips.length - audibleClips.length

  // Whether each clip's own sound is kept is decided here; whether it has any
  // is decided by the renderer, which probes the files.
  const videoClips = project.clips.filter(
    (clip) => assets.find((entry) => entry.id === clip.assetId)?.kind === 'video',
  )
  const silencedClips = videoClips.filter((clip) => clipGain(clip) <= 0).length

  // Worth counting: transitions are what makes an export shorter than the clips
  // add up to, and they are the part of the edit least visible from a clip list.
  const transitions = positioned.filter((entry) => entry.transition).length

  // Built as parts rather than one sentence, so a project with only clip sound
  // does not read "no audio · video clips keep their own sound".
  const sound: string[] = []
  if (audibleClips.length > 0) {
    const trackTotal = new Set(audibleClips.map((clip) => clip.trackId)).size
    sound.push(
      `${audibleClips.length} audio clip${audibleClips.length === 1 ? '' : 's'} across ` +
        `${trackTotal} track${trackTotal === 1 ? '' : 's'}` +
        (mutedCount > 0 ? ` · ${mutedCount} muted, not exported` : ''),
    )
  }
  if (videoClips.length > silencedClips) {
    sound.push(
      silencedClips > 0
        ? `video clips keep their own sound, except ${silencedClips} you silenced`
        : 'video clips keep their own sound',
    )
  } else if (silencedClips > 0) {
    sound.push(`video clip sound silenced`)
  }
  if (sound.length === 0) sound.push('no audio')

  // Only visible tracks are burnt in, matching the preview: hiding a caption
  // track is how you export a version without them without deleting the words.
  const visibleCaptionTracks = captionTracksOf(project).filter((track) => !track.hidden)
  const burntInCues = captionCuesOf(project).filter((cue) =>
    visibleCaptionTracks.some((track) => track.id === cue.trackId),
  )

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

      // Layers, in track order, which is the order they stack in. A hidden lane
      // is left out entirely rather than encoded at zero opacity: it would cost
      // an input and a filter chain to change not one pixel of the output.
      const overlays: NonNullable<RenderRequest['overlays']> = []
      for (const track of videoTracksOf(project)) {
        if (track.hidden) continue
        for (const clip of videoClipsOf(project)) {
          if (clip.trackId !== track.id || clip.duration <= 0) continue
          await collect(clip.assetId)
          const asset = assets.find((entry) => entry.id === clip.assetId)
          overlays.push({
            assetId: clip.assetId,
            kind: asset?.kind === 'video' ? 'video' : 'image',
            startTime: clip.startTime,
            inPoint: clip.inPoint,
            duration: clip.duration,
            opacity: opacityFor(videoTracksOf(project), clip),
            volume: layerGain(videoTracksOf(project), clip),
          })
        }
      }

      // Built from the layout rather than from the clips, so the transitions
      // that go to the encoder are the fitted ones the timeline has been showing
      // all along — not a stored wish that two short clips cannot cover.
      const clips = positioned.map(({ clip, duration, transition }) => {
        const asset = assets.find((entry) => entry.id === clip.assetId)
        return {
          assetId: clip.assetId,
          kind: (asset?.kind === 'video' ? 'video' : 'image') as 'video' | 'image',
          inPoint: clip.inPoint,
          duration,
          transition,
          volume: clipGain(clip),
        }
      })

      // Captions are authored against the export size, so this is built here
      // rather than kept on the project: changing the resolution above changes
      // the file, and the fonts are only fetched when there is something to
      // draw with them.
      const captions =
        burntInCues.length > 0
          ? {
              ass: buildAssFile({
                tracks: visibleCaptionTracks,
                cues: burntInCues,
                width: project.width,
                height: project.height,
              }),
              fonts: await captionFonts(),
            }
          : undefined

      const { blob } = await renderProject(
        {
          clips,
          overlays,
          audio,
          assets: needed,
          width: project.width,
          height: project.height,
          fps: project.fps,
          leadIn,
          ...(captions ? { captions } : {}),
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
          <Field
            label="Resolution"
            hint="Sizes follow the project's orientation — change it above the preview."
          >
            <Select
              value={`${project.width}x${project.height}`}
              disabled={busy}
              onChange={(event) => {
                const found = resolutions.find(
                  (option) => `${option.width}x${option.height}` === event.target.value,
                )
                if (found) setResolution(found.width, found.height)
              }}
            >
              {resolutions.map((option) => (
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
          {formatTime(outputDuration)}
          {/* Worth saying outright: it explains an export that is longer than
              the clips add up to, and confirms the count-in has room. */}
          {leadIn > 0 ? ` · ${formatTime(leadIn)} of black before the picture` : ''}
          {transitions > 0
            ? ` · ${transitions} transition${transitions === 1 ? '' : 's'}, which overlap the clips they join`
            : ''}{' '}
          · {sound.join(' · ')}
          {/* Burnt in, not a sidecar track — so it is worth saying so before a
              render that cannot be undone without doing it again. */}
          {burntInCues.length > 0
            ? ` · ${burntInCues.length} caption${burntInCues.length === 1 ? '' : 's'} burnt in`
            : ''}
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
