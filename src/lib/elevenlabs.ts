/**
 * ElevenLabs: the voice changer, and the account's voices.
 *
 * The voice changer takes a microphone recording and re-performs it in a
 * different voice, keeping the timing and delivery of the original. Fixing a
 * clip that says the words with the wrong sounds is the other job this provider
 * does for us, and it lives next door in `dubbing.ts` — the delivery is the part
 * that is wrong there, so keeping it is exactly the wrong move.
 *
 * No key appears anywhere in this file, and that is the whole arrangement: the
 * deployment's own is attached inside the proxy and never reaches the browser,
 * exactly as image and video generation already work, and as captions do through
 * fal (see `scribe.ts`). What these requests carry instead is the Auth0 session,
 * which is what the function checks before spending it.
 *
 * All traffic goes through /api/elevenlabs so we do not depend on ElevenLabs'
 * browser CORS policy.
 */
import { auth0Token } from './auth0/client'
import { providerErrorFrom } from './errors'
import { isMockEnabled, mockConvert, mockVoices } from './mock'

const PROXY_BASE = '/api/elevenlabs'

export interface Voice {
  voice_id: string
  name: string
  category?: string
  labels?: Record<string, string>
  preview_url?: string
}

interface VoicesResponse {
  voices: Voice[]
}

interface ModelsResponse {
  model_id: string
  name?: string
  can_do_voice_conversion?: boolean
  can_do_text_to_speech?: boolean
  /** What the model can speak. `language_id` is ISO-639-1, e.g. `es`. */
  languages?: { language_id?: string; name?: string }[]
}

/**
 * One request to the proxy, with whoever is asking attached.
 *
 * Exported for `dubbing.ts`, which is a second file of calls to the same
 * provider through the same proxy and must not grow a second idea of how to
 * reach it — particularly not of when the session token is read, which is per
 * request on purpose. A dub polls for minutes, and a token captured at the
 * start of one is a token that expires in the middle of it.
 */
export async function elevenFetch(path: string, init?: RequestInit): Promise<Response> {
  // The only credential this end has. It says who is asking; the proxy decides
  // whether that person may spend the site's key, and then attaches it.
  const token = await auth0Token().catch(() => null)

  const response = await fetch(`${PROXY_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw await providerErrorFrom('ElevenLabs', response)
  return response
}

/**
 * Whether this deployment has a key at all.
 *
 * Asked once and remembered: it is a property of the build on the other end of
 * the wire, not of the moment, and every voice control on screen reads it to
 * decide whether to work or to say the site is not set up for this. A checkout
 * served by plain `vite dev` has no /api routes, so this throws rather than
 * 404s — and the answer is the same either way, which is "not from here".
 */
let sitePromise: Promise<boolean> | null = null

export function siteProvidesKey(): Promise<boolean> {
  if (isMockEnabled()) return Promise.resolve(true)
  sitePromise ??= fetch(`${PROXY_BASE}/status`)
    .then(async (response) => {
      if (!response.ok) return false
      const body = (await response.json()) as { configured?: unknown }
      return body.configured === true
    })
    .catch(() => false)
  return sitePromise
}

export async function listVoices(signal?: AbortSignal): Promise<Voice[]> {
  if (isMockEnabled()) return mockVoices().voices

  const response = await elevenFetch('/v1/voices', { signal })
  const body = (await response.json()) as VoicesResponse
  return body.voices ?? []
}

/**
 * Finds a model that can actually do voice conversion.
 *
 * Asking the API rather than hardcoding an ID means this keeps working when
 * ElevenLabs retires or renames a model, which they do periodically.
 */
export async function findConversionModel(signal?: AbortSignal): Promise<string> {
  if (isMockEnabled()) return 'eleven_multilingual_sts_v2'

  try {
    const response = await elevenFetch('/v1/models', { signal })
    const models = (await response.json()) as ModelsResponse[]
    const capable = models.find((model) => model.can_do_voice_conversion)
    if (capable?.model_id) return capable.model_id
  } catch {
    // Fall through to the documented default rather than failing the whole
    // conversion just because the model list could not be read.
  }
  return 'eleven_multilingual_sts_v2'
}

export interface ConvertOptions {
  voiceId: string
  audio: Blob
  modelId?: string
  /** 0–1. Higher removes more background noise but can soften delivery. */
  removeBackgroundNoise?: boolean
  signal?: AbortSignal
}

/** Converts a recording into the chosen voice, returning the new audio. */
export async function convertVoice({
  voiceId,
  audio,
  modelId,
  removeBackgroundNoise = false,
  signal,
}: ConvertOptions): Promise<Blob> {
  if (isMockEnabled()) return mockConvert(audio)

  const model = modelId ?? (await findConversionModel(signal))

  const form = new FormData()
  // The extension matters: ElevenLabs sniffs the container from the filename
  // as well as the bytes.
  form.append('audio', audio, filenameFor(audio.type))
  form.append('model_id', model)
  form.append('remove_background_noise', String(removeBackgroundNoise))

  const response = await elevenFetch(`/v1/speech-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    body: form,
    headers: { accept: 'audio/mpeg' },
    signal,
  })

  return await response.blob()
}

/**
 * The languages the fix-audio dialog offers, in ElevenLabs' own vocabulary.
 *
 * ISO-639-1 here, where `scribe.ts` lists ISO-639-3: the same languages spelled
 * the way each provider spells them, rather than one list and a translation
 * table that would have to be right in both directions.
 *
 * There is no "detect it from the text" entry, and its absence is the largest
 * thing dubbing takes away. A dubbing job has exactly one target language and
 * every segment in it is re-said in that language; there is no per-line choice
 * and no reading the text as it is written. A clip that says a line in English
 * and then again in Spanish therefore has to be dubbed as one or the other, and
 * whichever is chosen the other half is said with the wrong mouth. See the
 * limitations in the README, and `clipAudioFix.ts` for what that costs.
 */
export const VOICE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Mandarin Chinese' },
] as const

/** A word, and when it was said, in seconds from the start of the audio. */
export interface SpokenWord {
  text: string
  start: number
  end: number
}

function filenameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'take.webm'
  if (mimeType.includes('ogg')) return 'take.ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'take.m4a'
  if (mimeType.includes('wav')) return 'take.wav'
  return 'take.mp3'
}
