/**
 * The model registry.
 *
 * Provider catalogues change every few weeks, so every ID the app depends on
 * lives in this one file, and every picker in the UI has a "custom model ID"
 * escape hatch. When an ID goes stale the provider's error surfaces verbatim in
 * the UI and the fix is a one-line edit here — no code change needed.
 *
 * Prices are fal.ai list prices at time of writing and are shown as estimates
 * only, because a wrong guess about cost is expensive for the user.
 */

export interface ImageModel {
  id: string
  label: string
  description: string
  /** Approximate USD per generated image. */
  approxCostPerImage: number
  /** Aspect ratios this model accepts, as fal's `image_size` enum values. */
  imageSizes: readonly string[]
  supportsNumImages: boolean
}

/**
 * How a model wants its duration expressed. This is the one place where
 * provider APIs disagree pointlessly: some take a number, some a numeric
 * string, some a string with a unit suffix.
 */
export type DurationFormat = 'number' | 'string' | 'seconds-suffix'

export interface VideoModel {
  id: string
  label: string
  description: string
  /** Approximate USD per second of generated video. */
  approxCostPerSecond: number
  /**
   * Per-resolution override, for models where one number would be badly wrong.
   * fal bills some models by pixel count, so 480p and 720p can differ five-fold
   * — far too wide a spread to show a single estimate for.
   */
  costPerSecondByResolution?: Readonly<Record<string, number>>
  /** Durations the model accepts, in seconds. The first is the default. */
  durations: readonly number[]
  /** Whether the model accepts a closing frame in addition to the opening one. */
  supportsEndFrame: boolean
  /** Resolution enum values the model accepts, if it takes one. */
  resolutions?: readonly string[]
  /** Which resolution to start on. Defaults to the last — the highest — entry. */
  defaultResolution?: string
  /**
   * `aspect_ratio` values the model accepts. Absent means it takes no such
   * field, and orientation is carried by the first frame instead. Opt-in on
   * purpose: fal rejects an unknown field outright with a 422, so guessing that
   * a model supports this would break it rather than degrade gracefully.
   */
  aspectRatios?: readonly string[]
  /** Set only where a `generate_audio` flag is known to exist. Same 422 risk. */
  supportsAudioToggle?: boolean
  durationFormat: DurationFormat
}

export interface LlmModel {
  id: string
  label: string
}

export const IMAGE_SIZES = [
  { value: 'landscape_16_9', label: 'Landscape 16:9' },
  { value: 'portrait_16_9', label: 'Portrait 9:16' },
  { value: 'square_hd', label: 'Square' },
  { value: 'landscape_4_3', label: 'Landscape 4:3' },
  { value: 'portrait_4_3', label: 'Portrait 3:4' },
] as const

export const IMAGE_MODELS: readonly ImageModel[] = [
  {
    id: 'fal-ai/flux/schnell',
    label: 'FLUX schnell',
    description: 'Fastest and cheapest. Good for exploring ideas before committing.',
    approxCostPerImage: 0.003,
    imageSizes: IMAGE_SIZES.map((s) => s.value),
    supportsNumImages: true,
  },
  {
    id: 'fal-ai/flux/dev',
    label: 'FLUX dev',
    description: 'Noticeably better detail and prompt adherence than schnell.',
    approxCostPerImage: 0.025,
    imageSizes: IMAGE_SIZES.map((s) => s.value),
    supportsNumImages: true,
  },
  {
    id: 'fal-ai/flux-pro/v1.1',
    label: 'FLUX 1.1 Pro',
    description: 'High quality, strong at photographic subjects.',
    approxCostPerImage: 0.04,
    imageSizes: IMAGE_SIZES.map((s) => s.value),
    supportsNumImages: true,
  },
  {
    id: 'fal-ai/nano-banana',
    label: 'Nano Banana',
    description: "Google's image model. Strong at following instructions literally.",
    approxCostPerImage: 0.039,
    imageSizes: IMAGE_SIZES.map((s) => s.value),
    supportsNumImages: true,
  },
  {
    id: 'fal-ai/bytedance/seedream/v3/text-to-image',
    label: 'Seedream 3',
    description: 'Good at text rendering inside images and at stylised art.',
    approxCostPerImage: 0.03,
    imageSizes: IMAGE_SIZES.map((s) => s.value),
    supportsNumImages: true,
  },
]

export const VIDEO_MODELS: readonly VideoModel[] = [
  {
    // Owner-scoped, so no `fal-ai/` prefix. Nothing needs to change for that:
    // the proxy forwards whatever path it is given, and the queue's status and
    // result URLs come back absolute and are rewritten by `toProxyPath`.
    id: 'bytedance/seedance-2.0/fast/image-to-video',
    label: 'Seedance 2.0 fast',
    description:
      'Quick and inexpensive at 480p. Takes an orientation, and can aim at a last frame.',
    approxCostPerSecond: 0.043,
    costPerSecondByResolution: { '480p': 0.043, '720p': 0.242 },
    durations: [5, 6, 8, 10, 12, 15],
    supportsEndFrame: true,
    resolutions: ['480p', '720p'],
    defaultResolution: '480p',
    aspectRatios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    supportsAudioToggle: true,
    durationFormat: 'string',
  },
  {
    id: 'fal-ai/kling-video/v2/master/image-to-video',
    label: 'Kling 2 Master',
    description: 'Strong physical motion and camera work. A good default.',
    approxCostPerSecond: 0.09,
    durations: [5, 10],
    supportsEndFrame: false,
    durationFormat: 'string',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    label: 'Hailuo 02',
    description: 'Cheaper, quick turnaround, good for simple animation.',
    approxCostPerSecond: 0.045,
    durations: [6, 10],
    supportsEndFrame: false,
    durationFormat: 'string',
  },
  {
    id: 'fal-ai/wan-i2v',
    label: 'Wan 2.1',
    description: 'Open model. Inexpensive and reliable for straightforward motion.',
    approxCostPerSecond: 0.04,
    durations: [5],
    supportsEndFrame: false,
    resolutions: ['480p', '720p'],
    durationFormat: 'number',
  },
  {
    id: 'fal-ai/luma-dream-machine/image-to-video',
    label: 'Luma Dream Machine',
    description: 'Cinematic camera movement from a single keyframe.',
    approxCostPerSecond: 0.11,
    durations: [5, 9],
    supportsEndFrame: true,
    durationFormat: 'seconds-suffix',
  },
  {
    id: 'fal-ai/veo3/image-to-video',
    label: 'Veo 3',
    description: 'Highest quality, and the only one here that generates audio. Expensive.',
    approxCostPerSecond: 0.4,
    durations: [8],
    supportsEndFrame: false,
    durationFormat: 'seconds-suffix',
  },
]

/**
 * Models available for the two "Improve with AI" buttons, routed through fal's
 * any-llm endpoint so prompt rewriting needs no third API key.
 */
export const LLM_MODELS: readonly LlmModel[] = [
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-flash-1.5', label: 'Gemini 1.5 Flash (cheapest)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'meta-llama/llama-3.2-3b-instruct', label: 'Llama 3.2 3B' },
]

export const LLM_ENDPOINT = 'fal-ai/any-llm'

/**
 * The speech model captioning downloads and runs in the browser.
 *
 * A Hugging Face repo id, resolved by transformers.js. Two things about it are
 * load-bearing and neither is obvious from the name:
 *
 *  - it must be an ONNX export, which is what the `onnx-community` and `Xenova`
 *    namespaces publish;
 *  - its generation config must carry `alignment_heads`, or word-level
 *    timestamps are unavailable and captions have nothing to highlight on. The
 *    `_timestamped` repos exist for exactly that, and transformers.js says so
 *    plainly when they are missing.
 *
 * Like every other model id here, this is one line to change — and Settings has
 * a box to override it without one, since a browser that has already downloaded
 * a model is a bad place to be told to wait for a release.
 */
export const DEFAULT_SPEECH_MODEL = 'onnx-community/whisper-base_timestamped'

/**
 * Weights to try, in order, until one will actually run.
 *
 * A ladder rather than a single choice, because "downloaded" and "runnable" are
 * different things and only the browser can tell them apart. A quantised export
 * can fail at session creation with an ONNX Runtime error about `MatMulNBits` —
 * the operator four-bit block quantisation compiles to — and nothing about the
 * download says so in advance. Which exports a repo publishes is also up to
 * whoever published it, so a missing file has to mean "try the next" rather than
 * "captions are unavailable".
 *
 * Ordered smallest first, ending somewhere that cannot fail for this reason:
 *
 *  - `q8` is the usual quantised export, about a quarter the download.
 *  - `int8` quantises per tensor instead of per block, so it compiles to
 *    different operators and survives where `q8` does not.
 *  - `fp32` is the model as trained. Several times the download and slower, but
 *    it contains no quantisation operators at all, so there is nothing left to
 *    be incompatible with.
 *
 * A repo id that publishes none of these is a setting away — see Settings.
 */
export const SPEECH_MODEL_DTYPES = ['q8', 'int8', 'fp32'] as const

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0]!.id
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]!.id
export const DEFAULT_LLM_MODEL = LLM_MODELS[0]!.id

export function findImageModel(id: string): ImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id)
}

export function findVideoModel(id: string): VideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id)
}

/**
 * Which resolution a model should start on.
 *
 * This used to be "the highest one offered", which is the wrong instinct for a
 * model priced by pixel count — it quietly picks the expensive option. A
 * declared default wins; one that is not actually in the list is ignored rather
 * than sent as an invalid enum.
 */
export function defaultResolutionFor(model: VideoModel): string {
  const options = model.resolutions ?? []
  if (model.defaultResolution && options.includes(model.defaultResolution)) {
    return model.defaultResolution
  }
  return options.at(-1) ?? ''
}

/** The estimate to show, preferring a per-resolution figure where one exists. */
export function costPerSecondFor(model: VideoModel, resolution: string): number {
  return model.costPerSecondByResolution?.[resolution] ?? model.approxCostPerSecond
}

/** Encodes a duration the way a given model wants to receive it. */
export function encodeDuration(seconds: number, format: DurationFormat): string | number {
  switch (format) {
    case 'string':
      return String(seconds)
    case 'seconds-suffix':
      return `${seconds}s`
    default:
      return seconds
  }
}

/** Formats an estimate, erring toward showing "<$0.01" rather than "$0.00". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '—'
  if (usd < 0.01) return '<$0.01'
  return `~$${usd.toFixed(2)}`
}
