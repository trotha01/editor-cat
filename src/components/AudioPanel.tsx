/**
 * Step 3: layer voiceovers, lay music under them, and count yourself in.
 *
 * Recording starts playback at the playhead so you narrate to picture, and the
 * take is pinned where you started. Takes are placed automatically: onto an
 * existing voice track if it is free at that moment, otherwise onto a new one.
 * That means you can record the same passage twice, or talk over yourself, and
 * both survive — without ever having to think about which track you are on.
 *
 * The count-in is just audio on the timeline, which is the whole trick: it plays
 * in the preview while you record, it slides anywhere you drag it, and it is
 * mixed into the export like anything else — so whoever performs to the finished
 * video hears the same three beeps you did.
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
import { formatTime, leadInOf } from '../lib/timeline'
import {
  COUNTDOWN_ASSET_NAME,
  COUNTDOWN_LABEL,
  COUNTDOWN_SPEC,
  countdownSeconds,
  countdownWav,
} from '../lib/countdown'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { canUseElevenLabs, useSettingsStore } from '../state/useSettingsStore'
import type { AudioClip } from '../lib/types'

const COUNT_IN_SECONDS = countdownSeconds()

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
  const assets = useAssetStore((state) => state.assets)
  const audioClips = useProjectStore((state) => state.project.audioClips)
  const addAudioClip = useProjectStore((state) => state.addAudioClip)
  const leadIn = useProjectStore((state) => leadInOf(state.project))
  const setLeadIn = useProjectStore((state) => state.setLeadIn)
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

  /**
   * Places the beeps at `startTime`, generating them the first time.
   *
   * The count-in is the same three seconds every time, so a second one points
   * at the bytes already stored rather than ingesting — and backing up to
   * Drive — another copy of an identical file.
   */
  const placeCountdown = async (startTime: number) => {
    const existing = assets.find(
      (asset) => asset.kind === 'audio' && asset.name === COUNTDOWN_ASSET_NAME,
    )
    let asset = existing
    if (!asset) {
      asset = await ingestBlob(countdownWav(), { kind: 'audio', name: COUNTDOWN_ASSET_NAME })
      addAsset(asset)
    }

    // The generated file's length is known exactly, so it is taken from the
    // spec rather than from whatever the browser probed it as.
    return addAudioClip('countdown', {
      assetId: asset.id,
      useConverted: false,
      startTime,
      inPoint: 0,
      duration: COUNT_IN_SECONDS,
      label: COUNTDOWN_LABEL,
    })
  }

  /**
   * Drops the three beeps so that they *lead into* the playhead: park it where
   * the take should begin, and the last beep is the second before it. Anywhere
   * else is a drag away, but this is the placement that needs no thought.
   */
  const addCountdown = async () => {
    setError(null)
    setPlacement(null)
    try {
      const startTime = Math.max(0, currentTime - COUNT_IN_SECONDS)
      const outcome = await placeCountdown(startTime)
      setPlacement(
        `Count-in added to ${outcome.trackName}, running into ${formatTime(
          startTime + COUNT_IN_SECONDS,
        )}. Drag it along its lane to put it exactly where you want it.`,
      )
    } catch (cause) {
      setError(toDisplayMessage(cause))
    }
  }

  /**
   * Beeps in front of everything, with the picture pushed back to make room.
   *
   * The two halves of that are separately available — a lead-in is a property
   * of the picture track, the beeps are audio — but wanting one without the
   * other here is rare enough that asking for both would just be a step to
   * forget. An existing lead-in that is already long enough is left alone.
   */
  const addCountdownBeforeVideo = async () => {
    setError(null)
    setPlacement(null)
    try {
      if (leadIn < COUNT_IN_SECONDS) setLeadIn(COUNT_IN_SECONDS)
      const outcome = await placeCountdown(0)
      setPlacement(
        `Count-in added to ${outcome.trackName}, in front of the picture. ` +
          `The video now starts at ${formatTime(Math.max(leadIn, COUNT_IN_SECONDS))} — ` +
          `drag the hatched block at the head of the picture track to change that.`,
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
        <p className="text-sm font-medium">Count-in beeps</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          {COUNTDOWN_SPEC.beeps} beeps, one a second, on their own lane. They play while you record,
          and they are mixed into the exported MP4, so anyone performing to the finished video gets
          the same count-in. Drag them along their lane afterwards to land them exactly.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void addCountdownBeforeVideo()}>
            <span aria-hidden>⏮️</span> Add before the video
          </Button>
          <Button onClick={() => void addCountdown()}>
            <span aria-hidden>⏱️</span> Add leading into{' '}
            {formatTime(Math.max(COUNT_IN_SECONDS, currentTime))}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-ink-dim">
          <b>Before the video</b> pushes the whole picture track back by {COUNT_IN_SECONDS}s and
          puts the beeps in the gap, so the count-in is over before the first frame. The other drops
          them so the last beep leads into the playhead, for counting into a take partway through.
        </p>
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
  const canConvert = useSettingsStore(canUseElevenLabs)
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

  useEffect(() => {
    if (!canConvert || voices) return
    let cancelled = false
    listVoices()
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
  }, [canConvert, voices])

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

      const converted = await convertVoice({ voiceId, audio: blob })
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

      {!canConvert ? (
        <Callout tone="warn">
          This site is not set up for voice conversion. Whoever deployed it needs to set
          ELEVENLABS_API_KEY, or you can use your own key from Settings.
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
