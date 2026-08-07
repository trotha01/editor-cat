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
 */
import { useEffect, useMemo, useRef } from 'react'
import { clipAtTime, clipGain, formatTime, layoutClips } from '../lib/timeline'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { useAssetUrl } from '../hooks/useAssetUrl'
import { gainFor } from '../lib/audioTracks'
import type { Asset, AudioClip, Clip } from '../lib/types'

/** How far a media element may drift before we correct it, in seconds. */
const SEEK_TOLERANCE = 0.3

function ClipLayer({
  clip,
  asset,
  active,
  nearby,
  currentTime,
  playing,
  start,
  gain,
}: {
  clip: Clip
  asset: Asset | undefined
  active: boolean
  nearby: boolean
  currentTime: number
  playing: boolean
  start: number
  /** Resolved clip gain. 0 means muted, and the element stays silent. */
  gain: number
}) {
  const url = useAssetUrl(asset)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Set once the browser has refused to start audible playback, so the next
  // frame does not ask again and get refused again. Pressing play is a user
  // gesture, so this stays false outside of automated browsers.
  const refusedSound = useRef(false)

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
          preload={active || nearby ? 'auto' : 'metadata'}
          className="size-full object-contain"
        />
      ) : (
        <img src={url} alt={asset.name} className="size-full object-contain" />
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

export function Preview({ currentTime, playing }: { currentTime: number; playing: boolean }) {
  const project = useProjectStore((state) => state.project)
  const assets = useAssetStore((state) => state.assets)

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const positioned = useMemo(() => layoutClips(project.clips), [project.clips])
  const active = useMemo(() => clipAtTime(project.clips, currentTime), [project.clips, currentTime])

  const aspect = `${project.width} / ${project.height}`

  return (
    <section className="flex flex-col gap-2" aria-label="Preview">
      <div
        className="relative w-full overflow-hidden rounded-xl border border-line bg-surface-2"
        style={{ aspectRatio: aspect }}
      >
        {project.clips.length === 0 ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-center">
            <span aria-hidden className="text-3xl">
              🎞️
            </span>
            <p className="text-sm text-ink-dim">Your timeline is empty</p>
            <p className="max-w-xs text-xs text-ink-dim">
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
              nearby={Math.abs(entry.index - (active?.index ?? 0)) <= 1}
              currentTime={currentTime}
              playing={playing}
              start={entry.start}
              gain={clipGain(entry.clip)}
            />
          ))
        )}

        {active === null && project.clips.length > 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-2">
            <p className="text-sm text-ink-dim">End of timeline</p>
          </div>
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

      <p className="text-xs text-ink-dim">
        Clips play their own sound, mixed with your audio tracks — the export is exactly what you
        hear here. Select a clip to mute it or set its level. Playhead at {formatTime(currentTime)}.
      </p>
    </section>
  )
}
