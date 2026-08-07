import { useEffect } from 'react'
import { Button } from './ui'
import { formatTimecode, stepFrames } from '../lib/timeline'
import { isTypingTarget } from '../lib/shortcuts'

/** Play/pause, scrub, and the keyboard shortcuts people expect. */
export function Transport({
  currentTime,
  duration,
  fps,
  playing,
  onToggle,
  onSeek,
}: {
  currentTime: number
  duration: number
  /** The project's frame rate: what the arrows step by and the readout counts in. */
  fps: number
  playing: boolean
  onToggle: () => void
  onSeek: (time: number) => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never steal keys from a field the user is typing in.
      if (isTypingTarget(event.target)) return

      // One frame per press, which is the smallest move that means anything:
      // a cut lands on a frame boundary, so a playhead that parks between two
      // is a playhead you cannot cut at. Shift covers a second at a time, for
      // getting across the timeline rather than aiming within it.
      const step = (frames: number) => {
        event.preventDefault()
        onSeek(stepFrames(currentTime, event.shiftKey ? frames * fps : frames, fps))
      }

      if (event.code === 'Space') {
        event.preventDefault()
        onToggle()
      } else if (event.key === 'ArrowLeft') {
        step(-1)
      } else if (event.key === 'ArrowRight') {
        step(1)
      } else if (event.key === 'Home') {
        onSeek(0)
      } else if (event.key === 'End') {
        onSeek(duration)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentTime, duration, fps, onSeek, onToggle])

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="primary"
        onClick={onToggle}
        disabled={duration <= 0}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        <span aria-hidden>{playing ? '⏸' : '▶'}</span>
        {playing ? 'Pause' : 'Play'}
      </Button>

      <input
        type="range"
        min={0}
        max={Math.max(duration, 0.001)}
        step={0.01}
        value={Math.min(currentTime, duration)}
        onChange={(event) => onSeek(Number(event.target.value))}
        disabled={duration <= 0}
        aria-label="Scrub through the timeline"
        className="min-w-0 flex-1"
      />

      <span
        className="shrink-0 text-xs tabular-nums text-ink-dim"
        title={`Minutes : seconds : frame, at ${fps}fps`}
      >
        {formatTimecode(currentTime, fps)} / {formatTimecode(duration, fps)}
      </span>
    </div>
  )
}
