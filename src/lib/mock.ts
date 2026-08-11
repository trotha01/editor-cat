/**
 * Offline mock provider mode, enabled with `VITE_MOCK_PROVIDERS=1`.
 *
 * The point is to make the whole app — generate, timeline, trim, voiceover,
 * export — exercisable with no API keys, no network, and no spend. That makes
 * the flow testable in CI, and it gives anyone evaluating the app a way to see
 * it work before deciding to pay for credits.
 *
 * The media produced here is real: images are drawn on a canvas and videos are
 * recorded off an animated canvas, so they have genuine dimensions, duration
 * and bytes, and the export path gets a real workout.
 */
import type { GenerationProgress } from './falClient'

export function isMockEnabled(): boolean {
  return import.meta.env.VITE_MOCK_PROVIDERS === '1'
}

/**
 * Whether a provider feature should be usable.
 *
 * In mock mode nothing is gated on a key, because there is no provider to
 * authenticate against — the whole point is to be able to walk the app without
 * one.
 */
export function hasAccess(key: string): boolean {
  return isMockEnabled() || key.trim().length > 0
}

const PALETTES = [
  ['#0ea5e9', '#6366f1'],
  ['#f97316', '#db2777'],
  ['#10b981', '#0891b2'],
  ['#a855f7', '#e11d48'],
]

function paletteFor(seed: string): [string, string] {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTES[hash % PALETTES.length] as [string, string]
}

function sizeFor(imageSize: unknown): { width: number; height: number } {
  switch (imageSize) {
    case 'portrait_16_9':
      return { width: 576, height: 1024 }
    case 'square_hd':
      return { width: 768, height: 768 }
    case 'landscape_4_3':
      return { width: 1024, height: 768 }
    case 'portrait_4_3':
      return { width: 768, height: 1024 }
    default:
      return { width: 1024, height: 576 }
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  prompt: string,
  t: number,
) {
  const [from, to] = paletteFor(prompt)
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, from)
  gradient.addColorStop(1, to)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // A moving element so mock "video" visibly animates and A/V sync is checkable.
  const radius = Math.min(width, height) * 0.12
  const cx = width * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 1.4)))
  const cy = height * (0.35 + 0.2 * Math.cos(t * 1.9))
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.font = `600 ${Math.round(width / 26)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  const words = prompt.slice(0, 90)
  ctx.fillText(words, width / 2, height - height * 0.12, width * 0.86)

  ctx.font = `500 ${Math.round(width / 42)}px system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.fillText('MOCK MODE — no API call was made', width / 2, height - height * 0.05, width * 0.86)
}

async function mockImage(
  input: Record<string, unknown>,
): Promise<{ images: { url: string; width: number; height: number }[] }> {
  const prompt = String(input.prompt ?? 'untitled')
  const { width, height } = sizeFor(input.image_size)
  const count = Math.max(1, Math.min(4, Number(input.num_images ?? 1)))

  const images = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable, so mock mode cannot draw images.')
      drawFrame(ctx, width, height, `${prompt} #${i + 1}`, i * 2)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not encode the mock image.')
      return { url: URL.createObjectURL(blob), width, height }
    }),
  )

  return { images }
}

/**
 * Adds a quiet tone to a captured canvas stream, so mock clips arrive with a
 * real audio track like footage from a camera — or from the video models that
 * now return sound. Silent mocks would leave the whole clip-sound path
 * (probing, mixing, preview) unexercised by the end-to-end run.
 *
 * Returns a teardown, or null where WebAudio will not start: a mock clip
 * without sound is much better than a mock clip that fails to record.
 */
function attachTone(stream: MediaStream): (() => void) | null {
  try {
    const context = new AudioContext()
    void context.resume()
    const oscillator = context.createOscillator()
    oscillator.frequency.value = 220
    const gain = context.createGain()
    // Loud enough to hear the cut between clips, quiet enough not to startle.
    gain.gain.value = 0.04
    const destination = context.createMediaStreamDestination()
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track)

    return () => {
      oscillator.stop()
      void context.close()
    }
  } catch {
    return null
  }
}

/**
 * Mock clips have to follow the requested orientation, not just be small.
 * The export letterboxes rather than crops, so a 640×360 mock dropped into a
 * vertical project would come out as a thin strip inside black bars — and the
 * end-to-end test would stop exercising the portrait path at all.
 */
function videoSizeFor(input: Record<string, unknown>): { width: number; height: number } {
  const ratio = String(input.aspect_ratio ?? '16:9')
  return ratio === '9:16' || ratio === '3:4'
    ? { width: 360, height: 640 }
    : { width: 640, height: 360 }
}

async function mockVideo(
  input: Record<string, unknown>,
  onProgress?: (p: GenerationProgress) => void,
  signal?: AbortSignal,
): Promise<{ video: { url: string; content_type: string } }> {
  const prompt = String(input.prompt ?? 'untitled')
  const seconds = Math.max(1, Math.min(10, Number(input.duration ?? 5)))
  const { width, height } = videoSizeFor(input)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable, so mock mode cannot render video.')

  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    throw new Error('This browser cannot record a canvas, so mock video generation is unavailable.')
  }

  const stream = canvas.captureStream(30)
  const stopTone = attachTone(stream)
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }))
  })

  recorder.start()
  const startedAt = performance.now()

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) {
        recorder.stop()
        stream.getTracks().forEach((track) => track.stop())
        stopTone?.()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const elapsed = (performance.now() - startedAt) / 1000
      drawFrame(ctx, width, height, prompt, elapsed)
      onProgress?.({
        status: 'IN_PROGRESS',
        elapsed,
        message: `Rendering mock video ${elapsed.toFixed(1)}s / ${seconds}s`,
      })
      if (elapsed >= seconds) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  recorder.stop()
  stream.getTracks().forEach((track) => track.stop())
  stopTone?.()
  const blob = await done

  return { video: { url: URL.createObjectURL(blob), content_type: blob.type } }
}

function mockLlm(input: Record<string, unknown>): { output: string } {
  const prompt = String(input.prompt ?? '')

  // Echo back something clearly shaped like an enhanced prompt so the diff UI
  // has real content to show, while staying obviously fake.
  const subject = prompt.split('\n').at(-1)?.slice(0, 200) ?? prompt
  return {
    output:
      `${subject.trim()}, rendered with cinematic depth of field, soft rim lighting from the left, ` +
      `shallow 35mm perspective, rich colour grading, fine surface detail, composed on the thirds. ` +
      `[mock enhancement — no LLM was called]`,
  }
}

const IDEA_TEMPLATES: ((word: string) => string)[] = [
  (w) => `A raccoon files a noise complaint against the moon for being too "${w}." "Take it up with the tide," the moon says.`,
  (w) => `A vending machine and a fire hydrant split the last ${w} between them. "Fair is fair," the hydrant hisses.`,
  (w) => `Two houseplants stage a coup over the sunny windowsill and a ${w}. "It's mine by right," one snaps.`,
  (w) => `A ghost tries to return a ${w} it stole in 1987. "Keep the receipt," the shopkeeper deadpans.`,
  (w) => `A traffic cone directs a marching band made of nothing but ${w}. "Left, then ${w}!" it barks.`,
  (w) => `An umbrella refuses to open until someone apologises for the ${w}. "Say sorry first," it insists.`,
  (w) => `A toaster interviews a loaf of bread for the job of "${w}." "You're overqualified," it says.`,
  (w) => `A cloud sues a lawnmower over a stolen ${w}. "The evidence is in the grass," the cloud rumbles.`,
  (w) => `A mailbox falls for a passing ${w}. "Write back," it whispers.`,
  (w) => `A stapler goes on strike until the office admits the ${w} was rigged. "Never again," it clicks.`,
]

/**
 * Twenty mock scene ideas, shaped like `ideaGenerator.ts`'s JSON contract so
 * the "Idea" tab is exercisable offline too. Cycled from a fixed template list
 * rather than duplicating `IDEA_COUNT` here, which would need importing
 * `ideaGenerator.ts` and create a module cycle back through `falClient.ts`.
 */
function mockIdeas(word: string): string[] {
  const trimmed = word.trim() || 'thing'
  return Array.from(
    { length: 20 },
    (_, i) => `${IDEA_TEMPLATES[i % IDEA_TEMPLATES.length]!(trimmed)} [mock idea — no LLM was called]`,
  )
}

/** Routes a mock request by model ID, mimicking the real client's contract. */
export async function mockFal<T>(
  modelId: string,
  input: Record<string, unknown>,
  onProgress?: (p: GenerationProgress) => void,
  signal?: AbortSignal,
): Promise<T> {
  onProgress?.({ status: 'IN_QUEUE', elapsed: 0 })

  if (modelId.includes('any-llm')) {
    await new Promise((resolve) => setTimeout(resolve, 400))

    // The idea generator's system prompt is the only "any-llm" caller that asks
    // for a JSON array, so it doubles as the mock's routing key without this
    // file needing to import `ideaGenerator.ts` directly.
    if (String(input.system_prompt ?? '').includes('JSON array')) {
      return { output: JSON.stringify(mockIdeas(String(input.prompt ?? ''))) } as T
    }
    return mockLlm(input) as T
  }

  if (modelId.includes('image-to-video') || modelId.includes('i2v') || modelId.includes('video')) {
    return (await mockVideo(input, onProgress, signal)) as T
  }

  await new Promise((resolve) => setTimeout(resolve, 600))
  onProgress?.({ status: 'IN_PROGRESS', elapsed: 0.6 })
  return (await mockImage(input)) as T
}

/** Mock voice list, shaped like the ElevenLabs response. */
export function mockVoices() {
  return {
    voices: [
      { voice_id: 'mock-rachel', name: 'Rachel (mock)', category: 'premade' },
      { voice_id: 'mock-adam', name: 'Adam (mock)', category: 'premade' },
      { voice_id: 'mock-bella', name: 'Bella (mock)', category: 'premade' },
    ],
  }
}

/**
 * Mock voice conversion. Returns the original audio unchanged — the point is to
 * exercise the plumbing (upload, store, A/B toggle, export mixing), and
 * pretending to change the timbre would only make the mock misleading.
 */
export async function mockConvert(audio: Blob): Promise<Blob> {
  await new Promise((resolve) => setTimeout(resolve, 700))
  return audio
}

/**
 * Long enough to be split into more than one caption, short enough that the
 * words land at something like a speaking pace once they are spread across the
 * audio. Packing thirty words into a three-second take would leave every word a
 * tenth of a second wide, and nothing downstream — grouping, retiming, the
 * highlight — would be exercised at the spacing it will really see.
 */
const MOCK_TRANSCRIPT = 'This is a mock transcript. No real speech was recognised.'

/**
 * Mock transcription. Invents words rather than recognising any, and says so in
 * the words themselves.
 *
 * The timings are the part that has to be real: they are spread across the
 * length of audio handed in, so grouping, the karaoke highlight, and the
 * burnt-in subtitle file are all exercised against a transcript that lines up
 * with something.
 */
export async function mockTranscribe(seconds: number): Promise<{
  words: { text: string; start: number; end: number }[]
  languageCode?: string
}> {
  await new Promise((resolve) => setTimeout(resolve, 300))

  const length = Number.isFinite(seconds) && seconds > 0.5 ? seconds : 4
  const tokens = MOCK_TRANSCRIPT.split(' ')
  const step = length / tokens.length

  return {
    words: tokens.map((text, index) => ({
      text,
      start: step * index,
      // A short gap after each word, so the grouping code sees pauses rather
      // than one unbroken run.
      end: step * (index + 0.8),
    })),
    languageCode: 'eng',
  }
}
