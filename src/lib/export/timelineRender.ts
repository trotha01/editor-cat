/**
 * A project, turned into the render request the encoder takes.
 *
 * This used to sit inside the export dialog, which was fine while a render had
 * exactly one thing that could happen to it — download. Publishing to Mintspace
 * is a second, and it wants the identical file: the same fitted transitions,
 * the same dropped mute tracks, the same burnt-in captions. Two destinations
 * assembling that separately is two chances for the file someone posts to
 * differ from the file they checked by downloading, so the assembly lives here
 * and the destinations are only what happens to the blob afterwards.
 *
 * `exportPlan` is separated from `renderTimeline` for the same reason. The
 * dialog describes the export in a sentence before anyone commits a minute of
 * CPU to it — how long it runs, how many transitions, what happens to the
 * sound — and a summary derived independently of the render is a summary free
 * to be wrong about it.
 */
import { renderProject, type ExportAsset, type RenderProgress, type RenderRequest } from './render'
import { buildAssFile } from './assCaptions'
import { captionFonts } from './captionFonts'
import { getBlob } from '../db'
import { clipGain, layoutClips, leadInOf } from '../timeline'
import { audioEnd, gainFor } from '../audioTracks'
import { layerGain, opacityFor, videoClipsOf, videoTracksOf } from '../videoTracks'
import { captionCuesOf, captionTracksOf } from '../captions'
import type {
  Asset,
  AudioClip,
  CaptionCue,
  CaptionTrack,
  Clip,
  PositionedClip,
  Project,
} from '../types'

export interface ExportPlan {
  /** Seconds of black before the picture starts. */
  leadIn: number
  /** The clips as the timeline actually lays them out, transitions fitted. */
  positioned: PositionedClip[]
  /** How long the finished file runs, sound included. */
  outputDuration: number
  /**
   * A good second to take a thumbnail from: just inside the picture, never in
   * the lead-in — a project that opens on two seconds of black would otherwise
   * be represented in a feed by two seconds of black.
   */
  posterTime: number
  /** Audio clips that will be encoded; muted tracks are not among them. */
  audibleClips: AudioClip[]
  /** How many audio clips are left out for sitting on a muted track. */
  mutedCount: number
  /** Timeline clips whose asset is a video, and so may carry sound of its own. */
  videoClips: Clip[]
  /** How many of those had their own sound turned down to nothing. */
  silencedClips: number
  /** Transitions in the fitted layout, which is what makes an export shorter. */
  transitions: number
  captionTracks: CaptionTrack[]
  /** Cues that will be burnt in: the ones on a track that is not hidden. */
  burntInCues: CaptionCue[]
}

/** Everything about an export that can be known before running it. */
export function exportPlan(project: Project, assets: Asset[]): ExportPlan {
  const leadIn = leadInOf(project)
  // Positions already carry the lead-in, so the last clip's end is where the
  // picture really finishes rather than how long it runs for.
  const positioned = layoutClips(project.clips, leadIn)
  const visualDuration = positioned.at(-1)?.end ?? 0

  // Muted tracks are dropped rather than exported at zero gain: encoding
  // silence costs time and gains nothing.
  const audibleClips = project.audioClips.filter((clip) => gainFor(project.audioTracks, clip) > 0)

  // Whether each clip's own sound is kept is decided here; whether it has any
  // is decided by the renderer, which probes the files.
  const videoClips = project.clips.filter(
    (clip) => assets.find((entry) => entry.id === clip.assetId)?.kind === 'video',
  )

  // Only visible tracks are burnt in, matching the preview: hiding a caption
  // track is how you export a version without them without deleting the words.
  const captionTracks = captionTracksOf(project).filter((track) => !track.hidden)
  const burntInCues = captionCuesOf(project).filter((cue) =>
    captionTracks.some((track) => track.id === cue.trackId),
  )

  // A second in, or halfway through a shorter picture than that.
  const picture = Math.max(0, visualDuration - leadIn)
  const posterTime = leadIn + Math.min(1, picture / 2)

  return {
    leadIn,
    positioned,
    outputDuration: Math.max(visualDuration, audioEnd(project.audioClips)),
    posterTime,
    audibleClips,
    mutedCount: project.audioClips.length - audibleClips.length,
    videoClips,
    silencedClips: videoClips.filter((clip) => clipGain(clip) <= 0).length,
    transitions: positioned.filter((entry) => entry.transition).length,
    captionTracks,
    burntInCues,
  }
}

export interface TimelineRenderOptions {
  project: Project
  assets: Asset[]
  crf: number
  onProgress?: (progress: RenderProgress) => void
  signal?: AbortSignal
}

/** Renders the project to an MP4, exactly as the preview shows it. */
export async function renderTimeline(options: TimelineRenderOptions): Promise<Blob> {
  const { project, assets, crf, onProgress, signal } = options
  const plan = exportPlan(project, assets)

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
  for (const clip of plan.audibleClips) {
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

  // Layers, in track order, which is the order they stack in. A hidden lane is
  // left out entirely rather than encoded at zero opacity: it would cost an
  // input and a filter chain to change not one pixel of the output.
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

  // Built from the layout rather than from the clips, so the transitions that
  // go to the encoder are the fitted ones the timeline has been showing all
  // along — not a stored wish that two short clips cannot cover.
  const clips = plan.positioned.map(({ clip, duration, transition }) => {
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

  // Captions are authored against the export size, so this is built here rather
  // than kept on the project: changing the resolution changes the file, and the
  // fonts are only fetched when there is something to draw with them.
  const captions =
    plan.burntInCues.length > 0
      ? {
          ass: buildAssFile({
            tracks: plan.captionTracks,
            cues: plan.burntInCues,
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
      leadIn: plan.leadIn,
      ...(captions ? { captions } : {}),
      crf,
    },
    { onProgress, signal },
  )

  return blob
}
