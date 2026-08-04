import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Microphone recording with a live level meter.
 *
 * Opus in a WebM container runs about 4KB per second, so even a long take stays
 * comfortably inside the proxy's payload limit when it is sent to ElevenLabs
 * for conversion.
 *
 * The stream is stopped on unmount as well as on stop — leaving a microphone
 * indicator lit after the user has moved on is alarming and rude.
 */

export interface RecorderState {
  recording: boolean
  /** Seconds elapsed in the current take. */
  elapsed: number
  /** 0–1 input level, for the meter. */
  level: number
  error: string | null
}

const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({
    recording: false,
    elapsed: 0,
    level: 0,
    error: null,
  })

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null)

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    recorderRef.current = null
  }, [])

  useEffect(() => teardown, [teardown])

  const start = useCallback(async () => {
    setState((previous) => ({ ...previous, error: null }))

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState((previous) => ({
        ...previous,
        error: 'This browser cannot record audio. Try Chrome, Edge, or Safari 15+.',
      }))
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        resolveRef.current?.(blob.size > 0 ? blob : null)
        resolveRef.current = null
        teardown()
        setState((previous) => ({ ...previous, recording: false, level: 0 }))
      }

      // Level meter, so the user can tell the microphone is actually live
      // before they commit to a long take.
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const buffer = new Uint8Array(analyser.frequencyBinCount)

      startedAtRef.current = performance.now()

      const tick = () => {
        analyser.getByteTimeDomainData(buffer)
        let peak = 0
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128) / 128)
        setState((previous) => ({
          ...previous,
          level: peak,
          elapsed: (performance.now() - startedAtRef.current) / 1000,
        }))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      recorder.start(250)
      setState({ recording: true, elapsed: 0, level: 0, error: null })
    } catch (cause) {
      const message =
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings and try again.'
          : cause instanceof Error
            ? cause.message
            : 'Could not start recording.'
      setState((previous) => ({ ...previous, recording: false, error: message }))
      teardown()
    }
  }, [teardown])

  /** Stops and resolves with the recorded audio. */
  const stop = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)

    return new Promise<Blob | null>((resolve) => {
      resolveRef.current = resolve
      recorder.stop()
    })
  }, [])

  const cancel = useCallback(() => {
    const recorder = recorderRef.current
    resolveRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    teardown()
    setState({ recording: false, elapsed: 0, level: 0, error: null })
  }, [teardown])

  return { ...state, start, stop, cancel }
}
