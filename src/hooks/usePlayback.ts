import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The playhead.
 *
 * Time is advanced from `performance.now()` deltas rather than from any one
 * media element's `currentTime`. The timeline mixes stills (which have no clock
 * at all) with videos and audio, so there is no single element that can be the
 * source of truth — the clock has to live above them, with the media elements
 * chased to match it.
 */
export function usePlayback(duration: number) {
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)

  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  // Mirrors currentTime for the rAF loop, which must not re-subscribe on every
  // frame just to read the latest value.
  const timeRef = useRef(0)
  const durationRef = useRef(duration)

  useEffect(() => {
    durationRef.current = duration
  }, [duration])

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const seek = useCallback((time: number) => {
    const clamped = Math.max(0, Math.min(time, durationRef.current))
    timeRef.current = clamped
    setCurrentTime(clamped)
  }, [])

  const pause = useCallback(() => {
    setPlaying(false)
    stopLoop()
  }, [stopLoop])

  const play = useCallback(() => {
    if (durationRef.current <= 0) return
    // Restart from the top when play is pressed at the very end.
    if (timeRef.current >= durationRef.current - 0.02) seek(0)
    lastTickRef.current = performance.now()
    setPlaying(true)
  }, [seek])

  const toggle = useCallback(() => {
    if (playing) pause()
    else play()
  }, [playing, pause, play])

  useEffect(() => {
    if (!playing) return

    lastTickRef.current = performance.now()

    const tick = (now: number) => {
      const delta = (now - lastTickRef.current) / 1000
      lastTickRef.current = now

      const next = timeRef.current + delta
      if (next >= durationRef.current) {
        timeRef.current = durationRef.current
        setCurrentTime(durationRef.current)
        setPlaying(false)
        rafRef.current = null
        return
      }

      timeRef.current = next
      setCurrentTime(next)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [playing])

  useEffect(() => stopLoop, [stopLoop])

  // If the project shortens under the playhead, do not leave it past the end.
  useEffect(() => {
    if (timeRef.current > duration) seek(duration)
  }, [duration, seek])

  return { currentTime, playing, play, pause, toggle, seek }
}
