/** Step 2: animate one of your images into a clip. */
import { useMemo, useRef, useState } from 'react'
import { PromptField } from './PromptField'
import { ModelPicker } from './ModelPicker'
import { GenerationStatus } from './GenerationStatus'
import { AssetThumb } from './AssetThumb'
import { Button, Callout, EmptyState, Field, Select, Spinner, TextArea } from './ui'
import { run, type GenerationProgress, type VideoOutput } from '../lib/falClient'
import { VIDEO_MODELS, encodeDuration, findVideoModel, formatCost } from '../lib/models'
import { getBlob } from '../lib/db'
import { imageInputFor, ingestFromUrl } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { hasAccess } from '../lib/mock'

export function VideoPanel() {
  const falKey = useSettingsStore((state) => state.fal)
  const model = useSettingsStore((state) => state.videoModel)
  const setPref = useSettingsStore((state) => state.setPref)
  const assets = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)
  const addClip = useProjectStore((state) => state.addClip)

  const images = useMemo(() => assets.filter((asset) => asset.kind === 'image'), [assets])

  const [firstFrameChoice, setFirstFrameChoice] = useState<string | null>(null)
  const [lastFrameId, setLastFrameId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [durationChoice, setDurationChoice] = useState<number | null>(null)
  const [resolutionChoice, setResolutionChoice] = useState<string | null>(null)
  const [extraJson, setExtraJson] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [progress, setProgress] = useState<GenerationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const modelInfo = findVideoModel(model)

  // Every model accepts its own fixed set of durations and resolutions, and
  // sending an unsupported one is a hard error. Rather than resetting state
  // whenever the model changes, the effective values are derived: the user's
  // choice is honoured while it is valid, and falls back when it is not.
  const durations = modelInfo?.durations ?? [5]
  const duration =
    durationChoice !== null && durations.includes(durationChoice)
      ? durationChoice
      : (durations[0] ?? 5)

  const resolutions = modelInfo?.resolutions ?? []
  const resolution = !resolutions.length
    ? ''
    : resolutionChoice && resolutions.includes(resolutionChoice)
      ? resolutionChoice
      : (resolutions.at(-1) ?? '')

  // Default to the newest image so the common path is a single click.
  const firstFrameId =
    firstFrameChoice && images.some((asset) => asset.id === firstFrameChoice)
      ? firstFrameChoice
      : (images[0]?.id ?? null)

  const firstFrame = images.find((asset) => asset.id === firstFrameId)
  const estimate = modelInfo ? modelInfo.approxCostPerSecond * duration : null

  const generate = async () => {
    if (!firstFrame || !prompt.trim()) return
    setError(null)
    setNote(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const blob = await getBlob(firstFrame.blobKey)
      if (!blob && !firstFrame.sourceUrl) {
        throw new Error('That image is no longer available locally. Generate or upload it again.')
      }
      const imageUrl = await imageInputFor(firstFrame, blob ?? new Blob())

      const input: Record<string, unknown> = {
        prompt: prompt.trim(),
        image_url: imageUrl,
        duration: encodeDuration(duration, modelInfo?.durationFormat ?? 'number'),
      }

      if (resolution) input.resolution = resolution

      if (modelInfo?.supportsEndFrame && lastFrameId) {
        const endAsset = images.find((asset) => asset.id === lastFrameId)
        if (endAsset) {
          const endBlob = await getBlob(endAsset.blobKey)
          input.end_image_url = await imageInputFor(endAsset, endBlob ?? new Blob())
        }
      }

      if (extraJson.trim()) {
        let extra: unknown
        try {
          extra = JSON.parse(extraJson)
        } catch {
          throw new Error('The extra parameters box does not contain valid JSON.')
        }
        if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
          Object.assign(input, extra)
        } else {
          throw new Error('Extra parameters must be a JSON object, for example {"seed": 42}.')
        }
      }

      const output = await run<VideoOutput>(model, input, {
        key: falKey,
        signal: controller.signal,
        onProgress: setProgress,
      })

      if (!output.video?.url) {
        throw new Error('The model returned no video. Try a different model or prompt.')
      }

      const asset = await ingestFromUrl(output.video.url, {
        kind: 'video',
        name: prompt.trim().slice(0, 40) || 'Generated clip',
        prompt: prompt.trim(),
        signal: controller.signal,
      })
      addAsset(asset)
      addClip(asset)
      setNote('Clip added to your library and to the end of the timeline.')
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const busy = progress !== null
  const missingKey = !hasAccess(falKey)

  if (images.length === 0) {
    return (
      <EmptyState icon="🖼️" title="Generate an image first">
        Video is made by animating a still. Make an image on the Image tab, or upload one in the
        Library, and it will show up here as a starting frame.
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {missingKey ? (
        <Callout tone="warn" title="Add your fal.ai key">
          Open Settings to add it before generating.
        </Callout>
      ) : null}

      <Field label="First frame" hint="The clip starts from this image.">
        <div className="grid grid-cols-4 gap-2">
          {images.slice(0, 12).map((asset) => (
            <AssetThumb
              key={asset.id}
              asset={asset}
              selected={asset.id === firstFrameId}
              onClick={() => setFirstFrameChoice(asset.id)}
            />
          ))}
        </div>
      </Field>

      <PromptField
        kind="video"
        label="Motion prompt"
        placeholder="Slow push in toward the lighthouse as the beam sweeps across the water"
        hint="Describe what moves and how the camera behaves — not what is already in the picture. Improve with AI is tuned for exactly that."
        value={prompt}
        onChange={setPrompt}
        rows={3}
        disabled={busy}
      />

      <ModelPicker
        label="Video model"
        options={VIDEO_MODELS}
        value={model}
        onChange={(id) => setPref('videoModel', id)}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Length">
          <Select
            value={duration}
            onChange={(event) => setDurationChoice(Number(event.target.value))}
            disabled={!modelInfo}
          >
            {durations.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} seconds
              </option>
            ))}
          </Select>
        </Field>
        {modelInfo?.resolutions?.length ? (
          <Field label="Resolution">
            <Select
              value={resolution}
              onChange={(event) => setResolutionChoice(event.target.value)}
            >
              {resolutions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>

      {modelInfo?.supportsEndFrame ? (
        <Field label="Last frame (optional)" hint="This model can also aim at a closing image.">
          <div className="grid grid-cols-4 gap-2">
            {images.slice(0, 8).map((asset) => (
              <AssetThumb
                key={asset.id}
                asset={asset}
                selected={asset.id === lastFrameId}
                onClick={() => setLastFrameId(asset.id === lastFrameId ? null : asset.id)}
              />
            ))}
          </div>
        </Field>
      ) : null}

      <div>
        <button
          type="button"
          className="text-xs text-ink-dim underline underline-offset-2 hover:text-ink"
          onClick={() => setShowAdvanced((open) => !open)}
        >
          {showAdvanced ? 'Hide advanced parameters' : 'Advanced parameters'}
        </button>
        {showAdvanced ? (
          <div className="mt-2">
            <Field
              label="Extra JSON parameters"
              hint="Merged into the request. Use this for model-specific options like seed or negative_prompt without waiting on an app update."
            >
              <TextArea
                rows={3}
                spellCheck={false}
                placeholder='{"seed": 42}'
                value={extraJson}
                onChange={(event) => setExtraJson(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </div>

      {progress ? (
        <GenerationStatus progress={progress} onCancel={() => abortRef.current?.abort()} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={generate}
            disabled={missingKey || !prompt.trim() || !firstFrame}
          >
            {busy ? <Spinner /> : <span aria-hidden>🎬</span>}
            Generate video
          </Button>
          {estimate !== null ? (
            <span className="text-xs text-ink-dim">
              Costs about {formatCost(estimate)} · usually takes 1–3 minutes
            </span>
          ) : null}
        </div>
      )}

      {error ? (
        <Callout tone="error" title="Generation failed">
          {error}
        </Callout>
      ) : null}
      {note ? <Callout tone="success">{note}</Callout> : null}
    </div>
  )
}
