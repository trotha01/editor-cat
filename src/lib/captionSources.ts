/**
 * What gets transcribed when you press "Add captions".
 *
 * Not everything on the timeline is speech, and transcribing the parts that are
 * not is worse than useless: a music bed comes back as invented lyrics, and a
 * count-in comes back as nothing at all after a round trip to a paid API. So the
 * sources are chosen rather than swept up — the voice tracks, and the sound
 * video clips carry themselves, which is where dialogue lives when the footage
 * was filmed rather than narrated.
 *
 * Anything silent is skipped for the same reason it is skipped by the exporter:
 * a muted track is not in the finished video, so words from it would caption
 * audio the viewer never hears.
 *
 * Pure, so the choice can be asserted on directly instead of by watching which
 * requests go out.
 */
import { clipGain, layoutClips, leadInOf } from './timeline'
import type { Asset, Project } from './types'

/** One piece of media to transcribe, and where it sits on the timeline. */
export interface SpeechSource {
  /** Stable per source, so progress can be reported against it. */
  id: string
  /** What to call it while it is being worked on. */
  label: string
  /** The asset whose bytes are read. Already resolved past a voice conversion. */
  assetId: string
  /** Where `inPoint` lands on the timeline, in seconds. */
  startTime: number
  /** Seconds into the source file. */
  inPoint: number
  /** How much of the source is used, in seconds. */
  duration: number
}

/**
 * Everything worth transcribing, in timeline order.
 *
 * Voice clips come from their track kind; a converted take is transcribed as
 * whichever version is set to play, because that is the one whose words and
 * timing end up in the export.
 */
export function speechSources(project: Project, assets: readonly Asset[]): SpeechSource[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const sources: SpeechSource[] = []

  const voiceTracks = new Map(
    (project.audioTracks ?? [])
      // Silent either way: a muted track and a track at zero are both dropped
      // from the export, so words from them would caption audio nobody hears.
      .filter((track) => track.kind === 'voice' && !track.muted && track.volume > 0)
      .map((track) => [track.id, track]),
  )

  for (const clip of project.audioClips ?? []) {
    const track = voiceTracks.get(clip.trackId)
    if (!track || clip.duration <= 0) continue
    const assetId =
      clip.useConverted && clip.convertedAssetId ? clip.convertedAssetId : clip.assetId
    sources.push({
      id: clip.id,
      label: assetById.get(assetId)?.name ?? track.name,
      assetId,
      startTime: clip.startTime,
      inPoint: clip.inPoint,
      duration: clip.duration,
    })
  }

  for (const positioned of layoutClips(project.clips, leadInOf(project))) {
    const asset = assetById.get(positioned.clip.assetId)
    // Stills have no sound, and a clip you silenced is not in the mix.
    if (asset?.kind !== 'video' || clipGain(positioned.clip) <= 0) continue
    if (positioned.duration <= 0) continue
    sources.push({
      id: positioned.clip.id,
      label: asset.name,
      assetId: asset.id,
      startTime: positioned.start,
      inPoint: positioned.clip.inPoint,
      duration: positioned.duration,
    })
  }

  return sources.sort((a, b) => a.startTime - b.startTime)
}
