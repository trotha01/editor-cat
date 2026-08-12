/** Step 2: turn a prompt into images. */
import { useMemo, useRef, useState } from 'react'
import { PromptField } from './PromptField'
import { ModelPicker } from './ModelPicker'
import { GenerationStatus } from './GenerationStatus'
import { ImageResults } from './ImageResults'
import { Button, Callout, Field, Select, Spinner } from './ui'
import { run, type GenerationProgress, type ImageOutput } from '../lib/falClient'
import { IMAGE_MODELS, IMAGE_SIZES, findImageModel, formatCost } from '../lib/models'
import { imageSizeFor, orientationOf } from '../lib/orientation'
import { ingestFromUrl } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { useSettingsStore } from '../state/useSettingsStore'
import { useAssetStore } from '../state/useAssetStore'
import { useImageResultsStore } from '../state/useImageResultsStore'
import { useProjectStore } from '../state/useProjectStore'

export function ImagePanel() {
  const model = useSettingsStore((state) => state.imageModel)
  const setPref = useSettingsStore((state) => state.setPref)
  const assets = useAssetStore((state) => state.assets)
  const addAsset = useAssetStore((state) => state.add)
  const resultIds = useImageResultsStore((state) => state.ids)
  const addResults = useImageResultsStore((state) => state.add)
  const addClip = useProjectStore((state) => state.addClip)
  const projectWidth = useProjectStore((state) => state.project.width)
  const projectHeight = useProjectStore((state) => state.project.height)

  const [prompt, setPrompt] = useState('')
  const [imageSizeChoice, setImageSizeChoice] = useState<string | null>(null)
  const [count, setCount] = useState(1)
  const [progress, setProgress] = useState<GenerationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const modelInfo = findImageModel(model)
  const estimate = modelInfo ? modelInfo.approxCostPerImage * count : null

  // Follows the project's orientation until someone picks a shape explicitly,
  // and then stays put. Every image_size is valid for every model, so unlike
  // duration and resolution there is no reason to override a deliberate choice.
  const imageSize = imageSizeChoice ?? imageSizeFor(orientationOf(projectWidth, projectHeight))

  // Resolved against the library each render rather than held as assets, so an
  // image deleted there drops out of the results instead of showing a picture
  // whose bytes are gone.
  const results = useMemo(
    () => resultIds.flatMap((id) => assets.find((asset) => asset.id === id) ?? []),
    [resultIds, assets],
  )

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
      const saved: string[] = []
      for (const [index, image] of images.entries()) {
        try {
          const asset = await ingestFromUrl(image.url, {
            kind: 'image',
            name: `${prompt.trim().slice(0, 40)}${images.length > 1 ? ` (${index + 1})` : ''}`,
            prompt: prompt.trim(),
            signal: controller.signal,
          })
          addAsset(asset)
          saved.push(asset.id)
        } catch (cause) {
          setError(toDisplayMessage(cause))
        }
      }

      if (saved.length > 0) {
        addResults(saved)
        setNote(`Added ${saved.length} image${saved.length === 1 ? '' : 's'} to your library.`)
      }
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const busy = progress !== null

  return (
    <div className="flex flex-col gap-4">
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
        <Field label="Shape" htmlFor="image-shape">
          <Select
            id="image-shape"
            value={imageSize}
            onChange={(event) => setImageSizeChoice(event.target.value)}
          >
            {IMAGE_SIZES.map((size) => (
              <option key={size.value} value={size.value}>
                {size.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How many" htmlFor="image-count">
          <Select
            id="image-count"
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          >
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
          <Button variant="primary" onClick={generate} disabled={!prompt.trim()}>
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

      {/* No "add the newest one" link here any more: every image below carries
          its own button, which says which image is being added. */}
      {note ? <Callout tone="success">{note}</Callout> : null}

      {results.length > 0 ? <ImageResults assets={results} onAdd={addClip} /> : null}
    </div>
  )
}
