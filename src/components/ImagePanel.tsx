/** Step 1: turn a prompt into images. */
import { useRef, useState } from 'react'
import { PromptField } from './PromptField'
import { ModelPicker } from './ModelPicker'
import { GenerationStatus } from './GenerationStatus'
import { Button, Callout, Field, Select, Spinner } from './ui'
import { run, type GenerationProgress, type ImageOutput } from '../lib/falClient'
import { IMAGE_MODELS, IMAGE_SIZES, findImageModel, formatCost } from '../lib/models'
import { ingestFromUrl } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import { hasAccess } from '../lib/mock'

export function ImagePanel() {
  const falKey = useSettingsStore((state) => state.fal)
  const model = useSettingsStore((state) => state.imageModel)
  const setPref = useSettingsStore((state) => state.setPref)
  const addAsset = useAssetStore((state) => state.add)
  const addClip = useProjectStore((state) => state.addClip)

  const [prompt, setPrompt] = useState('')
  const [imageSize, setImageSize] = useState<string>('landscape_16_9')
  const [count, setCount] = useState(1)
  const [progress, setProgress] = useState<GenerationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const modelInfo = findImageModel(model)
  const estimate = modelInfo ? modelInfo.approxCostPerImage * count : null

  const generate = async () => {
    if (!prompt.trim()) return
    setError(null)
    setNote(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const output = await run<ImageOutput>(
        model,
        { prompt: prompt.trim(), image_size: imageSize, num_images: count },
        {
          key: falKey,
          signal: controller.signal,
          onProgress: setProgress,
        },
      )

      const images = output.images ?? []
      if (images.length === 0) {
        setError('The model returned no images. Try a different prompt or model.')
        return
      }

      // Ingest sequentially so a partial failure still leaves earlier images
      // usable rather than losing the whole batch.
      let saved = 0
      for (const [index, image] of images.entries()) {
        try {
          const asset = await ingestFromUrl(image.url, {
            kind: 'image',
            name: `${prompt.trim().slice(0, 40)}${images.length > 1 ? ` (${index + 1})` : ''}`,
            prompt: prompt.trim(),
            signal: controller.signal,
          })
          addAsset(asset)
          saved += 1
        } catch (cause) {
          setError(toDisplayMessage(cause))
        }
      }

      if (saved > 0) {
        setNote(`Added ${saved} image${saved === 1 ? '' : 's'} to your library.`)
      }
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const busy = progress !== null
  const missingKey = !hasAccess(falKey)

  return (
    <div className="flex flex-col gap-4">
      {missingKey ? (
        <Callout tone="warn" title="Add your fal.ai key">
          Image generation, video generation, and prompt improvement all use your fal.ai key. Open
          Settings to add it.
        </Callout>
      ) : null}

      <PromptField
        kind="image"
        label="Image prompt"
        placeholder="A lighthouse on a cliff at dusk, storm clouds gathering over the sea"
        hint="Describe what should be in the frame. Improve with AI adds composition, lighting and lens detail."
        value={prompt}
        onChange={setPrompt}
        disabled={busy}
      />

      <ModelPicker
        label="Image model"
        options={IMAGE_MODELS}
        value={model}
        onChange={(id) => setPref('imageModel', id)}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Shape">
          <Select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
            {IMAGE_SIZES.map((size) => (
              <option key={size.value} value={size.value}>
                {size.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How many">
          <Select value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {progress ? (
        <GenerationStatus progress={progress} onCancel={() => abortRef.current?.abort()} />
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={generate} disabled={missingKey || !prompt.trim()}>
            {busy ? <Spinner /> : <span aria-hidden>🎨</span>}
            Generate {count > 1 ? `${count} images` : 'image'}
          </Button>
          {estimate !== null ? (
            <span className="text-xs text-ink-dim">Costs about {formatCost(estimate)}</span>
          ) : null}
        </div>
      )}

      {error ? (
        <Callout tone="error" title="Generation failed">
          {error}
        </Callout>
      ) : null}

      {note ? (
        <Callout tone="success">
          {note}{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              const newest = useAssetStore.getState().assets[0]
              if (newest) addClip(newest)
            }}
          >
            Add the newest one to the timeline
          </button>
          .
        </Callout>
      ) : null}
    </div>
  )
}
