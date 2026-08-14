/** Renders the timeline to an MP4 in the browser, then downloads or publishes it. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Callout, Field, Modal, Select, Spinner, TextInput } from './ui'
import { MintspacePublish } from './MintspacePublish'
import { exportPlan, renderTimeline } from '../lib/export/timelineRender'
import type { HlsPackage } from '../lib/export/render'
import { exportRangeOf, type ExportRange } from '../lib/export/range'
import type { RenderProgress } from '../lib/export/render'
import { downloadBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { formatBytes } from '../lib/db'
import { toDisplayMessage } from '../lib/errors'
import { exportPresetsFor, orientationOf, type ExportPreset } from '../lib/orientation'
import { isMintspaceConfigured } from '../lib/mintspace/client'
import { isR2Configured } from '../lib/r2/client'
import { usePersistedState } from '../hooks/usePersistedState'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'

const QUALITY = [
  { crf: 28, label: 'Smaller file' },
  { crf: 23, label: 'Balanced' },
  { crf: 18, label: 'Best quality' },
]

/**
 * Best quality, unless someone has said otherwise.
 *
 * A lower CRF costs encode time and megabytes, but an export is the thing
 * people keep and post — and a render that came out soft cannot be sharpened
 * afterwards, only done again. Paying for that up front is the better default;
 * the two cheaper settings are still one Select away for anyone who wants them.
 */
const DEFAULT_CRF = 18

const DESTINATIONS = [
  { id: 'download', label: 'Download an MP4' },
  { id: 'mintspace', label: 'Publish to Mintspace' },
] as const

type Destination = (typeof DESTINATIONS)[number]['id']

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

/**
 * Reads back a remembered choice, or the default.
 *
 * Storage is not a schema: what comes back may be from an older build, or hand
 * edited, or a destination this deployment no longer has. Anything unusable
 * falls back rather than being trusted — which for the destination also covers
 * the honest case of a site that has since dropped its Mintspace configuration,
 * where the remembered answer would otherwise open the dialog on a panel that
 * can only apologise.
 */
function usableDestination(stored: unknown): Destination {
  return stored === 'mintspace' && isMintspaceConfigured() ? 'mintspace' : 'download'
}

function usableQuality(stored: unknown): number {
  return QUALITY.some((option) => option.crf === stored) ? (stored as number) : DEFAULT_CRF
}

/** Seconds as the range boxes hold them: fine enough to name a frame, no finer. */
function secondsText(seconds: number): string {
  return (Math.round(Math.max(0, seconds) * 100) / 100).toString()
}

/**
 * What is wrong with a typed range, as a sentence, or null when nothing is.
 *
 * Said rather than quietly corrected. A box reading 200 on a project that runs
 * 87 seconds could be clamped without a word, but then the export is not the
 * one on screen — and the whole point of naming a start and an end is knowing
 * exactly what comes out.
 */
function rangeProblem(start: number, end: number, duration: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Give the start and end in seconds.'
  if (start < 0) return 'The start cannot be before the beginning.'
  if (end - start <= 0) return 'The end has to come after the start.'
  // A hundredth of slack, matching what the boxes are rounded to, so the end
  // filled in from the duration itself is never a hundredth too late.
  if (end > duration + 0.01) {
    return `This project runs ${formatTime(duration)}, so the end cannot be later than that.`
  }
  return null
}

/** Whether two ranges — either of which may be "the whole thing" — are the same. */
function sameRange(a: ExportRange | undefined, b: ExportRange | undefined): boolean {
  if (!a || !b) return a === b
  return a.start === b.start && a.end === b.end
}

/** A finished render, stamped with the settings that produced it. */
interface RenderedFile {
  blob: Blob
  /**
   * The streaming package, when this deployment can publish.
   *
   * Held alongside the MP4 rather than made on demand, so that rendering once
   * still covers both destinations — download the file to check it, then
   * publish, and what goes up is built from the very bytes that were checked.
   */
  hls?: HlsPackage
  poster?: Blob
  crf: number
  width: number
  height: number
  /** Undefined for a render of the whole timeline. */
  range: ExportRange | undefined
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useProjectStore((state) => state.project)
  const setResolution = useProjectStore((state) => state.setResolution)
  const recordPublication = useProjectStore((state) => state.recordPublication)
  const forgetPublication = useProjectStore((state) => state.forgetPublication)
  // What is marked on the timeline itself — with its Start/End buttons or the
  // I/O keys — which this dialog opens onto and stays in step with, so
  // marking a range there and sending it off here is one choice, not two.
  const timelineRange = useProjectStore((state) => state.exportRange)
  const setTimelineRange = useProjectStore((state) => state.setExportRange)
  const assets = useAssetStore((state) => state.assets)

  /**
   * Whether a finished export has anywhere to go besides this machine.
   *
   * Both halves are needed: Mintspace is the feed the row goes in, and R2 is
   * where the video itself is served from. With either missing the dialog only
   * downloads, and the render skips packaging entirely.
   */
  const canPublish = isMintspaceConfigured() && isR2Configured()

  // Remembered across exports, and across sessions: someone who publishes
  // everything to Mintspace at Best quality should not be re-choosing both on
  // every video. The frame size is not here — it lives on the project, where
  // it also drives the preview and the orientation toggle.
  const [storedDestination, setStoredDestination] = usePersistedState<Destination>(
    'editor-cat.exportDestination.v1',
    'download',
  )
  const [storedCrf, setStoredCrf] = usePersistedState('editor-cat.exportQuality.v1', DEFAULT_CRF)
  const destination = usableDestination(storedDestination)
  const crf = usableQuality(storedCrf)
  const [progress, setProgress] = useState<RenderProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState<RenderedFile | null>(null)
  const [downloaded, setDownloaded] = useState<Blob | null>(null)
  const [publishing, setPublishing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const resolutions = resolutionOptions(project.width, project.height)
  const vertical = orientationOf(project.width, project.height) === 'vertical'
  const plan = exportPlan(project, assets)

  // The range is deliberately not remembered the way the destination and the
  // quality are. Those describe a preference; this describes one timeline, and
  // "up to 0:42" means something else on a project that has since grown. So it
  // is held as typed — strings, so a half-written number is not rewritten under
  // the cursor — and resets to the whole video whenever the timeline's length
  // changes, which is also how it starts out.
  //
  // It is also seeded from whatever is marked on the timeline each time the
  // dialog opens, rather than always starting over from the whole video —
  // tracked alongside the duration in one piece of state so opening the
  // dialog and growing the timeline in the same tick cannot fire both resets
  // and leave the boxes disagreeing about which one happened last.
  const [typed, setTyped] = useState({ start: '0', end: secondsText(plan.outputDuration) })
  const [track, setTrack] = useState({ open, duration: plan.outputDuration })
  if (track.open !== open || track.duration !== plan.outputDuration) {
    const durationChanged = track.duration !== plan.outputDuration
    const justOpened = open && !track.open
    setTrack({ open, duration: plan.outputDuration })
    if (durationChanged) {
      setTyped({ start: '0', end: secondsText(plan.outputDuration) })
      setTimelineRange(null)
    } else if (justOpened) {
      const fitted = exportRangeOf(timelineRange, plan.outputDuration)
      if (fitted) setTyped({ start: secondsText(fitted.start), end: secondsText(fitted.end) })
    }
  }

  const startSeconds = Number(typed.start)
  const endSeconds = Number(typed.end)
  // Not asked of a timeline with nothing on it: both boxes read zero, which is
  // a range that names no video — but "add at least one clip" is already said
  // above and is the only thing anybody can do about it.
  const rangeError =
    plan.outputDuration > 0 ? rangeProblem(startSeconds, endSeconds, plan.outputDuration) : null
  /**
   * The range as the export will use it, or undefined for the whole timeline.
   *
   * Memoised because its identity is what decides when the Mintspace panel
   * re-fingerprints the project, and a fresh object every render would have it
   * hashing the whole document on every keystroke in the caption box.
   */
  const range = useMemo(
    () =>
      rangeError
        ? undefined
        : exportRangeOf({ start: startSeconds, end: endSeconds }, plan.outputDuration),
    [rangeError, startSeconds, endSeconds, plan.outputDuration],
  )
  const exportedLength = range ? range.end - range.start : plan.outputDuration

  // Kept in step with what is marked on the timeline itself: editing the
  // boxes here is as much "setting the start and end" as dragging their
  // handles there, and closing the dialog should leave the same stretch
  // marked. Skipped while a typed range is invalid — an in-progress edit is
  // not a choice yet — and while the dialog is closed, which the seeding
  // above already owns.
  useEffect(() => {
    if (!open || rangeError) return
    setTimelineRange(range ?? null)
  }, [open, rangeError, range, setTimelineRange])

  /**
   * The render on hand, but only while the settings above still describe it.
   *
   * Stamped and compared rather than thrown away when a Select changes, so that
   * nothing downstream can offer a file the dialog is no longer describing —
   * and so that changing your mind twice costs nothing, since a render that
   * matches again is a render that is still correct.
   */
  const current =
    rendered &&
    rendered.crf === crf &&
    rendered.width === project.width &&
    rendered.height === project.height &&
    sameRange(rendered.range, range)
      ? rendered
      : null

  // Built as parts rather than one sentence, so a project with only clip sound
  // does not read "no audio · video clips keep their own sound".
  const sound: string[] = []
  if (plan.audibleClips.length > 0) {
    const trackTotal = new Set(plan.audibleClips.map((clip) => clip.trackId)).size
    sound.push(
      `${plan.audibleClips.length} audio clip${plan.audibleClips.length === 1 ? '' : 's'} across ` +
        `${trackTotal} track${trackTotal === 1 ? '' : 's'}` +
        (plan.mutedCount > 0 ? ` · ${plan.mutedCount} muted, not exported` : ''),
    )
  }
  if (plan.videoClips.length > plan.silencedClips) {
    sound.push(
      plan.silencedClips > 0
        ? `video clips keep their own sound, except ${plan.silencedClips} you silenced`
        : 'video clips keep their own sound',
    )
  } else if (plan.silencedClips > 0) {
    sound.push(`video clip sound silenced`)
  }
  if (sound.length === 0) sound.push('no audio')

  /**
   * The MP4 itself, encoded if it has not been already.
   *
   * Handed to the Mintspace panel as well as used below, so that rendering,
   * downloading to check it, and then publishing the file you just checked
   * costs one encode rather than two — and publishes the very bytes that were
   * checked rather than an identically-configured second render of them.
   */
  const render = async (): Promise<RenderedFile> => {
    if (current) return current

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await renderTimeline({
        project,
        assets,
        crf,
        range,
        onProgress: setProgress,
        signal: controller.signal,
        // Asked for whenever publishing is possible, not only when it has been
        // chosen: forcing keyframes changes the encoded bytes, so packaging
        // only on demand would mean a second render for anyone who downloads a
        // file to check it and then decides to publish that.
        hls: canPublish,
      })
      const file: RenderedFile = {
        blob: result.blob,
        ...(result.hls ? { hls: result.hls } : {}),
        ...(result.poster ? { poster: result.poster } : {}),
        crf,
        width: project.width,
        height: project.height,
        range,
      }
      setRendered(file)
      return file
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const runDownload = async () => {
    setError(null)
    setDownloaded(null)

    try {
      const { blob } = await render()
      downloadBlob(blob, `${project.name.replace(/[^\w -]/g, '') || 'export'}.mp4`)
      setDownloaded(blob)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    }
  }

  const busy = progress !== null || publishing

  return (
    <Modal open={open} onClose={onClose} title="Export video" wide>
      <div className="flex flex-col gap-4">
        {project.clips.length === 0 ? (
          <Callout tone="warn">Add at least one clip to the timeline before exporting.</Callout>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Export to" htmlFor="export-destination">
            <Select
              id="export-destination"
              value={destination}
              disabled={busy}
              onChange={(event) => {
                setStoredDestination(event.target.value as Destination)
                setError(null)
              }}
            >
              {DESTINATIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Resolution"
            htmlFor="export-resolution"
            hint="Sizes follow the project's orientation — change it above the preview."
          >
            <Select
              id="export-resolution"
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

          <Field label="Quality" htmlFor="export-quality">
            <Select
              id="export-quality"
              value={crf}
              disabled={busy}
              onChange={(event) => setStoredCrf(Number(event.target.value))}
            >
              {QUALITY.map((option) => (
                <option key={option.crf} value={option.crf}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Start and end, which begin as the whole video: an export nobody has
            touched is the one they have been watching. */}
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="Start (seconds)" htmlFor="export-start">
            <TextInput
              id="export-start"
              type="number"
              min={0}
              max={secondsText(plan.outputDuration)}
              step={0.1}
              value={typed.start}
              disabled={busy}
              onChange={(event) => setTyped({ ...typed, start: event.target.value })}
            />
          </Field>

          <Field label="End (seconds)" htmlFor="export-end">
            <TextInput
              id="export-end"
              type="number"
              min={0}
              max={secondsText(plan.outputDuration)}
              step={0.1}
              value={typed.end}
              disabled={busy}
              onChange={(event) => setTyped({ ...typed, end: event.target.value })}
            />
          </Field>

          {/* Off only when the boxes already say the whole video. A range that
              does not add up is exactly when someone wants this. */}
          <Button
            variant="ghost"
            className="self-end"
            disabled={busy || (!range && !rangeError)}
            onClick={() => setTyped({ start: '0', end: secondsText(plan.outputDuration) })}
          >
            Export the whole video
          </Button>
        </div>

        {rangeError ? <Callout tone="warn">{rangeError}</Callout> : null}

        {destination === 'download' ? (
          <Callout tone="info" title="Everything happens on your machine">
            Rendering runs in this tab with ffmpeg compiled to WebAssembly — your media is never
            uploaded. That also means it uses your CPU: expect roughly a minute for a short project,
            and keep this tab in the foreground.
          </Callout>
        ) : (
          <Callout tone="info" title="Rendered here, then uploaded">
            The render still runs in this tab with ffmpeg compiled to WebAssembly, so your source
            media never leaves the machine — expect roughly a minute for a short project. Only the
            finished MP4 goes to Mintspace, where anyone can watch it.
          </Callout>
        )}

        <p className="text-sm text-ink-dim">
          {project.clips.length} clip{project.clips.length === 1 ? '' : 's'} ·{' '}
          {formatTime(exportedLength)}
          {/* Both numbers while a range is set, so the shorter one reads as a
              choice rather than as a timeline that has lost something. */}
          {range ? ` of ${formatTime(plan.outputDuration)}` : ''}
          {/* Worth saying outright: it explains an export that is longer than
              the clips add up to, and confirms the count-in has room. Only what
              survives the range — an export starting after the lead-in keeps
              none of it. */}
          {plan.leadIn > (range?.start ?? 0)
            ? ` · ${formatTime(plan.leadIn - (range?.start ?? 0))} of black before the picture`
            : ''}
          {plan.transitions > 0
            ? ` · ${plan.transitions} transition${plan.transitions === 1 ? '' : 's'}, which overlap the clips they join`
            : ''}{' '}
          · {sound.join(' · ')}
          {/* Burnt in, not a sidecar track — so it is worth saying so before a
              render that cannot be undone without doing it again. */}
          {plan.burntInCues.length > 0
            ? ` · ${plan.burntInCues.length} caption${plan.burntInCues.length === 1 ? '' : 's'} burnt in`
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
        ) : null}

        {/* Only while the dialog is actually up. The panel resolves a Mintspace
            session and fingerprints the timeline as it mounts, and neither is
            worth doing for a dialog nobody has opened — which, now that the
            destination is remembered, would otherwise happen on page load. */}
        {destination === 'mintspace' && open ? (
          <MintspacePublish
            render={render}
            project={project}
            crf={crf}
            range={range}
            empty={project.clips.length === 0 || rangeError !== null}
            vertical={vertical}
            busy={progress !== null}
            onBusyChange={setPublishing}
            onPublished={recordPublication}
            onForget={forgetPublication}
            onClose={onClose}
          />
        ) : destination === 'mintspace' || busy ? null : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={runDownload}
              disabled={project.clips.length === 0 || rangeError !== null}
            >
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

        {/* Only while it is still the file the settings above describe: change
            one of them and this is about a render nobody can now produce. */}
        {downloaded && downloaded === current?.blob ? (
          <Callout tone="success" title="Done">
            Exported {formatBytes(downloaded.size)}. The download should have started — if your
            browser blocked it,{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => downloadBlob(downloaded, `${project.name || 'export'}.mp4`)}
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
