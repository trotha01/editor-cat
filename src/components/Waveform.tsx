/**
 * The picture of a clip's sound, on a canvas.
 *
 * Shared by the two places sound shows up on the timeline — under the picture
 * clips, and inside the chips on the audio lanes — because both draw the same
 * thing: the stretch of a source its clip is showing, symmetrical about a
 * centre line, at whatever size the caller has room for. Where it sits, what
 * colour it is and whether it is worth naming to a screen reader are the
 * caller's business; the shape is this file's.
 */
import { useEffect, useRef } from 'react'
import { displayHeight, resampleBars, sliceForClip, type Peaks } from '../lib/waveform'

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

export function WaveformCanvas({
  peaks,
  inPoint,
  duration,
  width,
  height,
  className,
  style,
  label,
}: {
  /** Undefined while still decoding, null once known to hold nothing. */
  peaks: Peaks | null | undefined
  /** Seconds into the source the clip starts at. */
  inPoint: number
  /** How much of the source it shows, in seconds. */
  duration: number
  width: number
  height: number
  className?: string
  style?: React.CSSProperties
  /**
   * What a screen reader should call this. Left off where the waveform sits
   * inside something already named — repeating the clip is noise, not detail.
   */
  label?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) draw(canvas, peaks, inPoint, duration, width, height)
  }, [peaks, inPoint, duration, width, height])

  return (
    <canvas
      ref={canvasRef}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      style={{ ...style, width, height }}
      className={className}
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
