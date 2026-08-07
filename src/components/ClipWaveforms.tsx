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
import { useEffect, useRef, useState } from 'react'
import { cachedPeaks, peaksFor } from '../lib/audioPeaks'
import { clipGain, formatTime } from '../lib/timeline'
import { displayHeight, resampleBars, sliceForClip, type Peaks } from '../lib/waveform'
import type { Asset, PositionedClip } from '../lib/types'

export const WAVEFORM_LANE_HEIGHT = 40

/** Vertical breathing room inside the lane, so peaks do not touch the edges. */
const LANE_PADDING = 4

/**
 * CSS pixels per column of the envelope.
 *
 * Columns are drawn solid and edge to edge rather than as separated bars. At
 * the levels most footage sits at the shape is only a few pixels tall, and gaps
 * between bars turn that into a dotted line that reads as noise instead of as
 * sound.
 */
const COLUMN_WIDTH = 2

/**
 * Canvases have a hard pixel ceiling, past which the browser quietly hands back
 * a blank one. A long clip at maximum zoom would sail through it, so the
 * backing store is capped and the drawing scaled to fit — losing sub-pixel
 * detail nobody can see rather than the whole waveform.
 */
const MAX_BACKING_WIDTH = 8192

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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Undefined until it is known: "still decoding" and "decoded, nothing there"
  // are different states and the second one is worth showing.
  const [peaks, setPeaks] = useState<Peaks | null | undefined>(() => cachedPeaks(asset.id))

  useEffect(() => {
    let cancelled = false
    void peaksFor(asset).then((result) => {
      if (!cancelled) setPeaks(result)
    })
    return () => {
      cancelled = true
    }
  }, [asset])

  const width = Math.max(1, entry.duration * zoom)
  const height = WAVEFORM_LANE_HEIGHT - LANE_PADDING * 2
  const silent = clipGain(entry.clip) <= 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) draw(canvas, peaks, entry.clip.inPoint, entry.duration, width, height)
  }, [peaks, entry.clip.inPoint, entry.duration, width, height])

  const label = peaks
    ? `Sound from ${asset.name}, ${formatTime(entry.duration)} at ${formatTime(entry.start)}`
    : peaks === null
      ? `${asset.name} has no sound`
      : `Reading the sound from ${asset.name}`

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      title={label}
      style={{ left: entry.start * zoom, width, height, top: LANE_PADDING }}
      // Silence is dimmed rather than hidden: the clip still has that sound in
      // it, and unmuting has to be an obvious way to get it back.
      className={`pointer-events-none absolute text-sky-700 ${silent ? 'opacity-25' : 'opacity-90'}`}
    />
  )
}

/**
 * Paints the waveform for one clip.
 *
 * The colour comes from the element's own computed `color`, so the palette
 * stays in the stylesheet with every other colour in the app rather than being
 * a literal buried in a canvas call.
 */
function draw(
  canvas: HTMLCanvasElement,
  peaks: Peaks | null | undefined,
  inPoint: number,
  duration: number,
  cssWidth: number,
  cssHeight: number,
): void {
  const context = canvas.getContext('2d')
  // No 2D context in jsdom, and a browser under memory pressure can refuse one
  // too. Either way there is nothing to draw and nothing to fail.
  if (!context) return

  const ratio = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
  // Only the width is capped, and only the width: scaling the height down to
  // match would squash a long clip's waveform into a few pixels the moment it
  // was zoomed in far enough to hit the ceiling.
  const scaleX = Math.min(ratio, MAX_BACKING_WIDTH / Math.max(1, cssWidth))

  canvas.width = Math.max(1, Math.round(cssWidth * scaleX))
  canvas.height = Math.max(1, Math.round(cssHeight * ratio))

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = getComputedStyle(canvas).color || '#000'

  const middle = canvas.height / 2

  // A hairline through the middle, always. It is what makes an undecoded or
  // silent clip read as an empty lane rather than as a rendering failure.
  context.globalAlpha = 0.35
  context.fillRect(0, Math.round(middle), canvas.width, Math.max(1, Math.round(ratio)))
  context.globalAlpha = 1

  if (!peaks) return

  // Everything below is in backing pixels, which also bounds the work: a clip
  // wide enough to hit the cap gets the columns the canvas can actually hold
  // rather than one per CSS pixel of a width it cannot draw at.
  const columnWidth = Math.max(1, Math.round(COLUMN_WIDTH * scaleX))
  const columnCount = Math.max(1, Math.ceil(canvas.width / columnWidth))
  const columns = resampleBars(sliceForClip(peaks, inPoint, duration), columnCount)
  const limit = middle - ratio

  for (let column = 0; column < columns.length; column += 1) {
    const half = displayHeight(columns[column] ?? 0) * limit
    if (half <= 0) continue
    context.fillRect(column * columnWidth, middle - half, columnWidth, half * 2)
  }
}
