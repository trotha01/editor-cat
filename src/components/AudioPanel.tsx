/**
 * Step 3: layer voiceovers, and lay music under them.
 *
 * Recording starts playback at the playhead so you narrate to picture, and the
 * take is pinned where you started. Takes are placed automatically: onto an
 * existing voice track if it is free at that moment, otherwise onto a new one.
 * That means you can record the same passage twice, or talk over yourself, and
 * both survive — without ever having to think about which track you are on.
 *
 * A conversion never overwrites the original. Both are kept and switchable,
 * because voice conversion is a matter of taste and being unable to go back
 * would make it risky to even try.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Callout, EmptyState, Field, Select, Spinner } from './ui'
import { useRecorder } from '../hooks/useRecorder'
import { convertVoice, listVoices, type Voice } from '../lib/elevenlabs'
import { getBlob } from '../lib/db'
import { ingestBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { hasAccess } from '../lib/mock'
import type { AudioClip } from '../lib/types'

export function AudioPanel({
  currentTime,
  onPlay,
  onPause,
}: {
  currentTime: number
  onPlay: () => void
  onPause: () => void
}) {
  const recorder = useRecorder()
  const addAsset = useAssetStore((state) => state.add)
  const audioClips = useProjectStore((state) => state.project.audioClips)
  const addAudioClip = useProjectStore((state) => state.addAudioClip)
  const timelineDuration = useProjectStore((state) => state.duration())

  const anchorRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<string | null>(null)
  const musicInput = useRef<HTMLInputElement>(null)

  const beginRecording = async () => {
    setError(null)
    setPlacement(null)
    // Captured before the preview starts rolling, so the take lands where the
    // playhead was when the user hit record, not wherever it drifted to.
    anchorRef.current = currentTime
    await recorder.start()
    onPlay()
  }

  const finishRecording = async () => {
    onPause()
    const blob = await recorder.stop()
    if (!blob) {
      setError('Nothing was recorded. Check that the right microphone is selected.')
      return
    }
    try {
      const startTime = anchorRef.current
      const asset = await ingestBlob(blob, {
        kind: 'audio',
        name: `Voiceover at ${formatTime(startTime)}`,
      })
      addAsset(asset)

      const outcome = addAudioClip('voice', {
        assetId: asset.id,
        useConverted: false,
        startTime,
        inPoint: 0,
        duration: asset.duration && asset.duration > 0 ? asset.duration : recorder.elapsed,
      })

      setPlacement(
        outcome.createdTrack
          ? `Every voice track was busy at ${formatTime(startTime)}, so this take went onto a new one — ${outcome.trackName}.`
          : `Added to ${outcome.trackName}.`,
      )
    } catch (cause) {
      setError(toDisplayMessage(cause))
    }
  }

  const addMusic = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setError(null)
    setPlacement(null)
    try {
      if (!file.type.startsWith('audio/')) {
        throw new Error(`"${file.name}" is not an audio file.`)
      }
      const asset = await ingestBlob(file, { kind: 'audio', name: file.name })
      addAsset(asset)

      const outcome = addAudioClip('music', {
        assetId: asset.id,
        useConverted: false,
        // Score almost always starts at the top; drag it later if not.
        startTime: 0,
        inPoint: 0,
        duration: asset.duration && asset.duration > 0 ? asset.duration : 30,
        label: file.name,
      })
      setPlacement(
        `"${file.name}" added to ${outcome.trackName}. Drag it on the timeline to retime it.`,
      )
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      if (musicInput.current) musicInput.current.value = ''
    }
  }

  const voiceClips = audioClips.filter((clip) => !clip.label)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium">Record a voiceover</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          Recording starts the preview from wherever the playhead is, so you can narrate to picture.
          Record as many times as you like — takes layer onto separate tracks automatically.
        </p>

        {recorder.recording ? (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex size-3">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex size-3 rounded-full bg-red-500" />
              </span>
              <span className="text-sm tabular-nums">{recorder.elapsed.toFixed(1)}s</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full bg-emerald-500 transition-[width] duration-75"
                  style={{ width: `${Math.min(100, recorder.level * 140)}%` }}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" onClick={finishRecording}>
                ⏹ Stop and keep
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  recorder.cancel()
                  onPause()
                }}
              >
                Discard
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={beginRecording} disabled={timelineDuration <= 0}>
              <span aria-hidden>🎙️</span> Record from {formatTime(currentTime)}
            </Button>
            {timelineDuration <= 0 ? (
              <span className="text-xs text-ink-dim">Add a clip to the timeline first.</span>
            ) : null}
          </div>
        )}

        {recorder.error ? <Callout tone="error">{recorder.error}</Callout> : null}
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium">Music and score</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          Add a track and it sits under your narration at half volume. Adjust the level with the
          slider beside the track on the timeline.
        </p>
        <Button className="self-start" onClick={() => musicInput.current?.click()}>
          <span aria-hidden>🎵</span> Add music
        </Button>
        <input
          ref={musicInput}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(event) => void addMusic(event.target.files)}
        />
      </div>

      {placement ? <Callout tone="success">{placement}</Callout> : null}
      {error ? <Callout tone="error">{error}</Callout> : null}

      {voiceClips.length === 0 ? (
        <EmptyState icon="🎧" title="No takes yet">
          Record one above. Afterwards you can convert any take into a different voice with
          ElevenLabs.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {voiceClips.map((clip) => (
            <TakeCard key={clip.id} clip={clip} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TakeCard({ clip }: { clip: AudioClip }) {
  const elevenKey = useSettingsStore((state) => state.elevenlabs)
  const updateAudioClip = useProjectStore((state) => state.updateAudioClip)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)
  const trackName = useProjectStore(
    (state) => state.project.audioTracks.find((track) => track.id === clip.trackId)?.name,
  )
  const addAsset = useAssetStore((state) => state.add)
  const assets = useAssetStore((state) => state.assets)

  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [voiceId, setVoiceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasKey = hasAccess(elevenKey)

  useEffect(() => {
    if (!hasKey || voices) return
    let cancelled = false
    listVoices(elevenKey)
      .then((list) => {
        if (cancelled) return
        setVoices(list)
        setVoiceId((current) => current || (list[0]?.voice_id ?? ''))
      })
      .catch((cause) => {
        if (!cancelled) setError(toDisplayMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [hasKey, elevenKey, voices])

  const convert = async () => {
    const source = assets.find((asset) => asset.id === clip.assetId)
    if (!source) {
      setError('The original recording is no longer available.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const blob = await getBlob(source.blobKey)
      if (!blob) throw new Error('The original recording is no longer in local storage.')

      const converted = await convertVoice({ key: elevenKey, voiceId, audio: blob })
      const voiceName = voices?.find((voice) => voice.voice_id === voiceId)?.name ?? 'Converted'

      const asset = await ingestBlob(converted, {
        kind: 'audio',
        name: `${source.name} — ${voiceName}`,
      })
      addAsset(asset)
      updateAudioClip(clip.id, {
        convertedAssetId: asset.id,
        useConverted: true,
        voiceName,
      })
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden>🎙️</span>
        <span className="text-sm font-medium">
          {formatTime(clip.startTime)} · {formatTime(clip.duration)}
        </span>
        {trackName ? (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-dim">
            {trackName}
          </span>
        ) : null}
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => removeAudioClip(clip.id)}
          aria-label="Delete this take"
        >
          🗑
        </Button>
      </div>

      {clip.convertedAssetId ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-dim">Playing:</span>
          <Button
            variant={clip.useConverted ? 'ghost' : 'primary'}
            onClick={() => updateAudioClip(clip.id, { useConverted: false })}
          >
            Your voice
          </Button>
          <Button
            variant={clip.useConverted ? 'primary' : 'ghost'}
            onClick={() => updateAudioClip(clip.id, { useConverted: true })}
          >
            {clip.voiceName ?? 'Converted'}
          </Button>
        </div>
      ) : null}

      {!hasKey ? (
        <Callout tone="warn">
          Add your ElevenLabs key in Settings to change this into another voice.
        </Callout>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-44 flex-1">
            <Field label="Target voice">
              <Select
                value={voiceId}
                onChange={(event) => setVoiceId(event.target.value)}
                disabled={!voices || busy}
              >
                {voices?.map((voice) => (
                  <option key={voice.voice_id} value={voice.voice_id}>
                    {voice.name}
                  </option>
                )) ?? <option>Loading voices…</option>}
              </Select>
            </Field>
          </div>
          <Button onClick={convert} disabled={!voiceId || busy}>
            {busy ? <Spinner /> : <span aria-hidden>🪄</span>}
            {clip.convertedAssetId ? 'Convert again' : 'Change voice'}
          </Button>
        </div>
      )}

      {error ? <Callout tone="error">{error}</Callout> : null}
    </li>
  )
}
