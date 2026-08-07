/**
 * Captions over the preview, with one word lit at a time.
 *
 * This has to look like the export, not merely like captions: the size, weight,
 * outline and position are all fractions of the frame, and the frame here is
 * whatever the preview happens to be scaled to. So the overlay is measured, and
 * every length is expressed against the measured height — which is the same
 * arithmetic the ASS file does against the export height. The typeface is the
 * one that gets burnt in, loaded from the very files ffmpeg is handed.
 *
 * Which word is lit comes from `wordSpans`, the same function the exporter turns
 * into subtitle events, so the preview cannot drift from the render.
 */
import { useEffect, useRef, useState } from 'react'
import { CAPTION_FONT_FAMILY, activeWordIndexAt, cueAtTime } from '../lib/captions'
import type { CaptionCue, CaptionStyle, CaptionTrack } from '../lib/types'

export function CaptionOverlay({
  tracks,
  cues,
  currentTime,
}: {
  tracks: readonly CaptionTrack[]
  cues: readonly CaptionCue[]
  currentTime: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  // Measured rather than taken from the project: the preview is scaled to fit
  // whatever room it has, and fullscreen changes it again.
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry?.contentRect.height ?? 0)
    })
    observer.observe(element)
    setHeight(element.getBoundingClientRect().height)
    return () => observer.disconnect()
  }, [])

  const visible = tracks.filter((track) => !track.hidden)

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden">
      {visible.map((track) => {
        const cue = cueAtTime(
          cues.filter((entry) => entry.trackId === track.id),
          currentTime,
        )
        if (!cue || height <= 0) return null
        return (
          <CaptionLine
            key={track.id}
            trackId={track.id}
            cue={cue}
            style={track.style}
            frameHeight={height}
            activeIndex={activeWordIndexAt(cue, currentTime)}
          />
        )
      })}
    </div>
  )
}

/**
 * One caption, drawn where the style says.
 *
 * Anchored by its bottom rather than centred, because that is what libass does
 * with a bottom-aligned subtitle: a caption long enough to wrap grows upwards,
 * away from the edge of the frame, instead of half of it sliding off. The offset
 * is the same arithmetic `bottomMargin` does in the exporter — half a line up
 * from `position`, so a single line still has its middle exactly on the mark.
 *
 * Words are separate elements only so one of them can be recoloured; the spacing
 * between them is ordinary text spacing, so nothing shifts as the highlight
 * travels across the line.
 */
function CaptionLine({
  trackId,
  cue,
  style,
  frameHeight,
  activeIndex,
}: {
  trackId: string
  cue: CaptionCue
  style: CaptionStyle
  frameHeight: number
  activeIndex: number
}) {
  const fontSize = style.fontScale * frameHeight
  const outline = fontSize * style.outlineScale

  return (
    <p
      // Says which lane put this on screen, so a second caption track can be
      // told from the first without reading its colours back.
      data-caption-track={trackId}
      style={{
        position: 'absolute',
        left: '6%',
        right: '6%',
        bottom: Math.max(0, frameHeight * (1 - style.position) - fontSize / 2),
        margin: 0,
        textAlign: 'center',
        textWrap: 'balance',
        fontFamily: `"${CAPTION_FONT_FAMILY}", system-ui, sans-serif`,
        fontWeight: style.bold ? 700 : 400,
        fontSize,
        lineHeight: 1.15,
        color: style.color,
        textTransform: style.uppercase ? 'uppercase' : 'none',
        // paint-order draws the stroke behind the fill, so a thick outline eats
        // into the surrounding space rather than into the letterforms.
        paintOrder: 'stroke fill',
        WebkitTextStrokeWidth: outline,
        WebkitTextStrokeColor: style.outlineColor,
        // The same soft drop the ASS style carries, for light backgrounds.
        textShadow: `0 ${fontSize * 0.03}px ${fontSize * 0.04}px rgb(0 0 0 / 0.5)`,
      }}
    >
      {cue.words.map((word, index) => (
        <span key={word.id} style={index === activeIndex ? { color: style.highlightColor } : {}}>
          {index > 0 ? ' ' : ''}
          {word.text}
        </span>
      ))}
    </p>
  )
}
