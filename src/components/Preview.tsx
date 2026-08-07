/**
 * The preview canvas.
 *
 * Media elements are chased to the playhead rather than driving it: on each
 * frame we work out which clip should be showing and at what source time, then
 * nudge the corresponding element into place. Seeking only happens when it has
 * drifted past a tolerance, because seeking every frame makes playback stutter
 * badly.
 *
 * Clips play whatever sound they carry, at the level set on the clip, because
 * that is what the exporter mixes. Preview and output have to agree: hearing
 * something here that vanishes from the export — or the reverse — is worse
 * than either being silent.
 *
 * Fullscreen takes this whole section, transport and all. The alternative —
 * handing one `<video>` to the browser's own fullscreen — would show a single
 * clip, drop the audio tracks layered over it, and leave no way to pause.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { clipAtTime, clipGain, formatTime, layoutClips, leadInOf } from '../lib/timeline'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { useAssetSource, useAssetUrl } from '../hooks/useAssetUrl'
import { useFullscreen } from '../hooks/useFullscreen'
import { useReportReadiness } from '../hooks/useReportReadiness'
import { ReadinessBanner } from './ReadinessBanner'
import { gainFor } from '../lib/audioTracks'
import { captionCuesOf, captionTracksOf } from '../lib/captions'
import { CaptionOverlay } from './CaptionOverlay'
import { isTypingTarget } from '../lib/shortcuts'
import type { Asset, AudioClip, Clip } from '../lib/types'

/** How far a media element may drift before we correct it, in seconds. */
const SEEK_TOLERANCE = 0.3

/**
 * How many clips either side of the playhead are fetched in full.
 *
 * There is a real cost to every element told to load: memory, and on some
 * platforms a hard cap on how many videos can be decoding at once. So it is a
 * window rather than the whole timeline. Wide enough that the next few cuts are
 * in hand before the playhead reaches them, which is where the stutter was.
 */
const WARM_CLIPS = 3

function ClipLayer({
  clip,
  asset,
  active,
  warm,
  currentTime,
  playing,
  start,
  gain,
}: {
  clip: Clip
  asset: Asset | undefined
  active: boolean
  /** Near enough the playhead to be worth fetching in full ahead of time. */
  warm: boolean
  currentTime: number
  playing: boolean
  start: number
  /** Resolved clip gain. 0 means muted, and the element stays silent. */
  gain: number
}) {
  const { url, failed } = useAssetSource(asset)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Set once the browser has refused to start audible playback, so the next
  // frame does not ask again and get refused again. Pressing play is a user
  // gesture, so this stays false outside of automated browsers.
  const refusedSound = useRef(false)
  // How a still reports readiness: it has no buffering, so it is decoded or it
  // is not. Stamped with the URL it is about, which is what makes a new source
  // start from unknown again without an effect having to reset anything.
  const [decoded, setDecoded] = useState<{ url: string; broken: boolean } | null>(null)
  const imageLoaded = decoded?.url === url && !decoded.broken
  const imageBroken = decoded?.url === url && decoded.broken

  useReportReadiness({
    clipId: clip.id,
    videoRef,
    kind: asset?.kind,
    url,
    failed,
    from: clip.inPoint,
    to: clip.outPoint,
    // Only the clip under a running playhead can be *stalling* playback. The
    // rest are merely not loaded yet, which is expected and not worth an alarm.
    wanted: active && playing,
    warm: active || warm,
    imageLoaded,
    imageBroken,
  })

  // Park a warmed-up clip on its own in-point.
  //
  // Buffering follows the playhead of the element, which starts at zero — so a
  // clip trimmed to five seconds an hour into its source would sit there
  // fetching an hour of material it will never show, and still be empty at the
  // moment it is cut to. One seek, once metadata has landed, points the fetch
  // at the part the clip is actually made of.
  useEffect(() => {
    const element = videoRef.current
    if (!element || asset?.kind !== 'video' || active || !warm) return

    const park = () => {
      if (element.readyState < HTMLMediaElement.HAVE_METADATA) return
      if (Math.abs(element.currentTime - clip.inPoint) > SEEK_TOLERANCE) {
        element.currentTime = clip.inPoint
      }
    }

    park()
    element.addEventListener('loadedmetadata', park)
    return () => element.removeEventListener('loadedmetadata', park)
  }, [active, asset?.kind, clip.inPoint, warm])

  useEffect(() => {
    const element = videoRef.current
    if (!element || asset?.kind !== 'video') return

    if (!active) {
      if (!element.paused) element.pause()
      return
    }

    element.volume = Math.max(0, Math.min(1, gain))
    element.muted = gain <= 0 || refusedSound.current

    const target = clip.inPoint + Math.max(0, currentTime - start)
    if (Math.abs(element.currentTime - target) > SEEK_TOLERANCE) {
      element.currentTime = target
    }

    if (playing && element.paused) {
      void element.play().catch(() => {
        // Audible playback can be refused where muted playback would be
        // allowed. Dropping the sound keeps the picture moving, which beats
        // freezing the preview on one frame.
        refusedSound.current = true
        element.muted = true
        return element.play().catch(() => undefined)
      })
    } else if (!playing && !element.paused) {
      element.pause()
    }
  }, [active, asset?.kind, clip.inPoint, currentTime, gain, playing, start])

  if (!asset || !url) return null

  return (
    <div className={`absolute inset-0 ${active ? '' : 'invisible'}`} aria-hidden={!active}>
      {asset.kind === 'video' ? (
        <video
          ref={videoRef}
          src={url}
          playsInline
          preload={active || warm ? 'auto' : 'metadata'}
          className="size-full object-contain"
        />
      ) : (
        <img
          src={url}
          alt={asset.name}
          onLoad={() => setDecoded({ url, broken: false })}
          onError={() => setDecoded({ url, broken: true })}
          className="size-full object-contain"
        />
      )}
    </div>
  )
}

/**
 * One audio clip on one track. Every layered clip gets its own element, so
 * overlapping takes really do play together rather than cutting each other
 * off — which is the whole point of having more than one track.
 */
function AudioLayer({
  clip,
  asset,
  gain,
  currentTime,
  playing,
}: {
  clip: AudioClip
  asset: Asset | undefined
  /** Resolved track gain. 0 means muted, and the element stays silent. */
  gain: number
  currentTime: number
  playing: boolean
}) {
  const url = useAssetUrl(asset)
  const audioRef = useRef<HTMLAudioElement>(null)

  const active = currentTime >= clip.startTime && currentTime < clip.startTime + clip.duration

  useEffect(() => {
    const element = audioRef.current
    if (!element) return

    element.volume = Math.max(0, Math.min(1, gain))

    if (!active || !playing || gain <= 0) {
      if (!element.paused) element.pause()
      return
    }

    // The source may be trimmed, so the playhead maps to inPoint + offset.
    const target = clip.inPoint + (currentTime - clip.startTime)
    if (Math.abs(element.currentTime - target) > SEEK_TOLERANCE) {
      element.currentTime = Math.max(0, target)
    }
    if (element.paused) void element.play().catch(() => undefined)
  }, [active, clip.inPoint, clip.startTime, currentTime, gain, playing])

  if (!url) return null
  return <audio ref={audioRef} src={url} preload="auto" className="hidden" />
}

export function Preview({
  currentTime,
  playing,
  children,
}: {
  currentTime: number
  playing: boolean
  /** The transport, so it comes along into fullscreen instead of being left behind. */
  children?: ReactNode
}) {
  const project = useProjectStore((state) => state.project)
  const assets = useAssetStore((state) => state.assets)

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const leadIn = leadInOf(project)
  const positioned = useMemo(() => layoutClips(project.clips, leadIn), [project.clips, leadIn])
  const active = useMemo(
    () => clipAtTime(project.clips, currentTime, leadIn),
    [project.clips, currentTime, leadIn],
  )
  // Before the picture starts there is nothing to show, which is the point —
  // but it is not the end of the timeline, and must not say so.
  const beforePicture = currentTime < leadIn

  const { ref, active: fullscreen, supported, toggle } = useFullscreen<HTMLElement>()

  const empty = project.clips.length === 0
  const offerFullscreen = supported && !empty

  useEffect(() => {
    if (!offerFullscreen) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'f' && event.key !== 'F') return
      // Leave the browser's own Ctrl/Cmd-F and friends alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      toggle()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [offerFullscreen, toggle])

  const aspect = `${project.width} / ${project.height}`
  // Fullscreen puts everything on black, where the page's ink colours vanish.
  const panel = fullscreen ? 'bg-black text-white/70' : 'bg-surface-2 text-ink-dim'

  return (
    <section
      ref={ref}
      className={`flex flex-col gap-3 ${fullscreen ? 'justify-center bg-black p-4' : ''}`}
      aria-label="Preview"
    >
      <div
        className={`relative w-full overflow-hidden ${
          // Out of fullscreen the box is the project's shape. In it, the box is
          // whatever is left over and the media letterboxes itself inside.
          fullscreen ? 'min-h-0 flex-1' : 'rounded-xl border border-line bg-surface-2'
        }`}
        style={fullscreen ? undefined : { aspectRatio: aspect }}
      >
        {empty ? (
          <div
            className={`flex size-full flex-col items-center justify-center gap-1 text-center ${panel}`}
          >
            <span aria-hidden className="text-3xl">
              🎞️
            </span>
            <p className="text-sm">Your timeline is empty</p>
            <p className="max-w-xs text-xs">
              Generate an image, animate it into a clip, then add it below.
            </p>
          </div>
        ) : (
          positioned.map((entry) => (
            <ClipLayer
              key={entry.clip.id}
              clip={entry.clip}
              asset={assetById.get(entry.clip.assetId)}
              active={active?.clip.id === entry.clip.id}
              warm={Math.abs(entry.index - (active?.index ?? 0)) <= WARM_CLIPS}
              currentTime={currentTime}
              playing={playing}
              start={entry.start}
              gain={clipGain(entry.clip)}
            />
          ))
        )}

        {active === null && !empty ? (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-1 ${
              // The lead-in is black in the export, so it is black here too.
              beforePicture ? 'bg-black text-white/70' : panel
            }`}
          >
            <p className="text-sm">{beforePicture ? 'Lead-in' : 'End of timeline'}</p>
            {beforePicture ? (
              <p className="text-xs">The picture starts at {formatTime(leadIn)}</p>
            ) : null}
          </div>
        ) : null}

        {/* Above the picture and above the lead-in card, because captions are
            part of the frame: narration over black is exactly when you want to
            see them. Below the fullscreen button, which is chrome. */}
        <CaptionOverlay
          tracks={captionTracksOf(project)}
          cues={captionCuesOf(project)}
          width={project.width}
          height={project.height}
          currentTime={currentTime}
        />

        {/* Opposite the fullscreen button, on the same layer of chrome: both
            sit over the picture and neither should cover the other. */}
        <ReadinessBanner />

        {offerFullscreen ? (
          <button
            type="button"
            onClick={toggle}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            // Its own colours rather than the shared Button: this sits over
            // arbitrary picture, so it has to stay legible against anything.
            className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-lg bg-black/55 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <span aria-hidden>⛶</span>
            {fullscreen ? 'Exit' : 'Fullscreen'}
          </button>
        ) : null}
      </div>

      {project.audioClips.map((clip) => {
        const assetId =
          clip.useConverted && clip.convertedAssetId ? clip.convertedAssetId : clip.assetId
        return (
          <AudioLayer
            key={clip.id}
            clip={clip}
            asset={assetById.get(assetId)}
            gain={gainFor(project.audioTracks, clip)}
            currentTime={currentTime}
            playing={playing}
          />
        )
      })}

      {children ? (
        // On black, the transport keeps its own surface rather than being
        // recoloured: every control in it stays exactly as legible as it was.
        <div className={fullscreen ? 'rounded-xl bg-surface px-3 py-2 shadow-lg' : ''}>
          {children}
        </div>
      ) : null}

      {fullscreen ? null : (
        <p className="text-xs text-ink-dim">
          Clips play their own sound, mixed with your audio tracks — the export is exactly what you
          hear here. Select a clip to mute it or set its level. Playhead at{' '}
          {formatTime(currentTime)}.
        </p>
      )}
    </section>
  )
}
