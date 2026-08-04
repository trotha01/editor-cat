/**
 * Step 4: record a voiceover, then optionally re-perform it in another voice.
 *
 * Recording starts playback at the current playhead so you are narrating to
 * picture, and the take is anchored where you started — which is the only
 * behaviour that makes "record over the video" mean anything.
 *
 * The original recording is never overwritten by a conversion. Both are kept
 * and switchable, because voice conversion is a matter of taste and being
 * unable to go back would make it risky to even try.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, EmptyState, Field, Select, Spinner } from './ui'
import { useRecorder } from '../hooks/useRecorder'
import { convertVoice, listVoices, type Voice } from '../lib/elevenlabs'
import { getBlob } from '../lib/db'
import { ingestBlob, newId } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { hasAccess } from '../lib/mock'
import type { VoiceoverTake } from '../lib/types'

export function VoicePanel({
  currentTime,
  onPlay,
  onPause,
}: {
  currentTime: number
  onPlay: () => void
  onPause: () => void
}) {
  const recorder = useRecorder()
  const elevenKey = useSettingsStore((state) => state.elevenlabs)
  const addAsset = useAssetStore((state) => state.add)
  const voiceovers = useProjectStore((state) => state.project.voiceovers)
  const addVoiceover = useProjectStore((state) => state.addVoiceover)
  const timelineDuration = useProjectStore((state) => state.duration())

  const [anchor, setAnchor] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const beginRecording = async () => {
    setError(null)
    setAnchor(currentTime)
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
      const asset = await ingestBlob(blob, {
        kind: 'audio',
        name: `Voiceover at ${formatTime(anchor)}`,
      })
      addAsset(asset)
      const take: VoiceoverTake = {
        id: newId('take'),
        assetId: asset.id,
        useConverted: false,
        startTime: anchor,
        duration: asset.duration && asset.duration > 0 ? asset.duration : recorder.elapsed,
      }
      addVoiceover(take)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium">Record a voiceover</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          Recording starts the preview from wherever the playhead is, so you can narrate to picture.
          The take is pinned to that point on the timeline.
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
                  className="h-full bg-emerald-400 transition-[width] duration-75"
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
        {error ? <Callout tone="error">{error}</Callout> : null}
      </div>

      {voiceovers.length === 0 ? (
        <EmptyState icon="🎧" title="No takes yet">
          Record one above. Afterwards you can convert it into a different voice with ElevenLabs.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {voiceovers.map((take) => (
            <TakeCard key={take.id} take={take} elevenKey={elevenKey} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TakeCard({ take, elevenKey }: { take: VoiceoverTake; elevenKey: string }) {
  const updateVoiceover = useProjectStore((state) => state.updateVoiceover)
  const removeVoiceover = useProjectStore((state) => state.removeVoiceover)
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
    const source = assets.find((asset) => asset.id === take.assetId)
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
      updateVoiceover(take.id, {
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
          Take at {formatTime(take.startTime)} · {formatTime(take.duration)}
        </span>
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => removeVoiceover(take.id)}
          aria-label="Delete this take"
        >
          🗑
        </Button>
      </div>

      {take.convertedAssetId ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-dim">Playing:</span>
          <Button
            variant={take.useConverted ? 'ghost' : 'primary'}
            onClick={() => updateVoiceover(take.id, { useConverted: false })}
          >
            Your voice
          </Button>
          <Button
            variant={take.useConverted ? 'primary' : 'ghost'}
            onClick={() => updateVoiceover(take.id, { useConverted: true })}
          >
            {take.voiceName ?? 'Converted'}
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
            {take.convertedAssetId ? 'Convert again' : 'Change voice'}
          </Button>
        </div>
      )}

      {error ? <Callout tone="error">{error}</Callout> : null}
    </li>
  )
}
