import { useEffect } from 'react'
import { Button } from './ui'
import { formatTime } from '../lib/timeline'

/** Play/pause, scrub, and the keyboard shortcuts people expect. */
export function Transport({
  currentTime,
  duration,
  playing,
  onToggle,
  onSeek,
}: {
  currentTime: number
  duration: number
  playing: boolean
  onToggle: () => void
  onSeek: (time: number) => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal keys from a field the user is typing in.
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return

      if (event.code === 'Space') {
        event.preventDefault()
        onToggle()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onSeek(currentTime - (event.shiftKey ? 1 : 0.1))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onSeek(currentTime + (event.shiftKey ? 1 : 0.1))
      } else if (event.key === 'Home') {
        onSeek(0)
      } else if (event.key === 'End') {
        onSeek(duration)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentTime, duration, onSeek, onToggle])

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

      <span className="shrink-0 text-xs tabular-nums text-ink-dim">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  )
}
