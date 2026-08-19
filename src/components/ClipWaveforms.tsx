/**
 * The clip-sound lane: what each video clip's own audio looks like, under the
 * picture it belongs to.
 *
 * This is a view, not a track. A clip's sound cannot be lifted off its clip —
 * it is trimmed with it and mixed where it sits — so there is nothing here to
 * drag, and pointer events pass straight through to whatever is beneath. What
 * it buys is the thing that was previously guesswork: where somebody actually
 * speaks. Line a count-in up against that, or park a cut in a gap, without
 * playing the timeline over and over to find the moment by ear.
 *
 * Each clip draws the slice of its source it is showing, so a trim moves the
 * waveform with the picture and the two halves of a cut carry on from each
 * other exactly as the sound does.
 */
import { WaveformCanvas } from './Waveform'
import { useAssetPeaks } from '../hooks/useAssetPeaks'
import { clipGain, formatTime } from '../lib/timeline'
import type { Asset, PositionedClip } from '../lib/types'

export const WAVEFORM_LANE_HEIGHT = 40

/** Vertical breathing room inside the lane, so peaks do not touch the edges. */
const LANE_PADDING = 4

export interface WaveformEntry {
  entry: PositionedClip
  asset: Asset
}

export function ClipWaveformLane({
  entries,
  zoom,
}: {
  entries: readonly WaveformEntry[]
  zoom: number
}) {
  if (entries.length === 0) return null

  return (
    <div
      className="relative mt-2 rounded bg-surface-2"
      style={{ height: WAVEFORM_LANE_HEIGHT }}
      aria-label="Sound from the video clips"
    >
      {entries.map(({ entry, asset }) => (
        <ClipWaveform key={entry.clip.id} entry={entry} asset={asset} zoom={zoom} />
      ))}
    </div>
  )
}

function ClipWaveform({ entry, asset, zoom }: WaveformEntry & { zoom: number }) {
  const peaks = useAssetPeaks(asset)

  const width = Math.max(1, entry.duration * zoom)
  const silent = clipGain(entry.clip) <= 0

  const label = peaks
    ? `Sound from ${asset.name}, ${formatTime(entry.duration)} at ${formatTime(entry.start)}`
    : peaks === null
      ? `${asset.name} has no sound`
      : `Reading the sound from ${asset.name}`

  return (
    <WaveformCanvas
      peaks={peaks}
      inPoint={entry.clip.inPoint}
      duration={entry.duration}
      width={width}
      height={WAVEFORM_LANE_HEIGHT - LANE_PADDING * 2}
      label={label}
      style={{ left: entry.start * zoom, top: LANE_PADDING }}
      // Silence is dimmed rather than hidden: the clip still has that sound in
      // it, and unmuting has to be an obvious way to get it back.
      className={`pointer-events-none absolute text-sky-700 ${silent ? 'opacity-25' : 'opacity-90'}`}
    />
  )
}
