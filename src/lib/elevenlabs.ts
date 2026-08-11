/**
 * ElevenLabs: the voice changer, and the voice that says a line properly.
 *
 * Two jobs. The voice changer takes a microphone recording and re-performs it in
 * a different voice, keeping the timing and delivery of the original. Speaking is
 * the other direction — text in, audio out — and it is what fixes a clip whose
 * generated dialogue says the words with the wrong sounds: nothing can correct a
 * pronunciation that has already been performed, so the line is said again from
 * the text.
 *
 * Both are paid for by the deployment, like image and video generation and like
 * captions, which reach the same company's Scribe through fal (see `scribe.ts`).
 * Nothing here asks the visitor for a key: the site's own is attached by the
 * proxy, which is also why these requests carry the Auth0 session — that is what
 * the function checks before spending it.
 *
 * A key the user *has* entered still wins, and is forwarded once and forgotten,
 * for anyone who would rather use their own quota and their own voice library.
 * `key` is therefore an ordinary empty string most of the time, and the header
 * is simply left off.
 *
 * All traffic goes through /api/elevenlabs so we do not depend on ElevenLabs'
 * browser CORS policy.
 */
import { auth0Token } from './auth0/client'
import { providerErrorFrom, ProviderError } from './errors'
import { isMockEnabled, mockClonedVoiceId, mockConvert, mockSpeech, mockVoices } from './mock'

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

async function elevenFetch(path: string, key: string, init?: RequestInit): Promise<Response> {
  // Sent when there is one, which is what the proxy reads to decide whose
  // account this is. Without it the site's key pays, and the session below is
  // what says the caller may spend it.
  const token = await auth0Token().catch(() => null)

  const response = await fetch(`${PROXY_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(key.trim() ? { 'xi-api-key': key.trim() } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw await providerErrorFrom('ElevenLabs', response)
  return response
}

/**
 * Whether this deployment provides a key of its own.
 *
 * Asked once and remembered: it is a property of the build on the other end of
 * the wire, not of the moment, and every voice control on screen reads it to
 * decide whether to work or to ask for a key. A checkout served by plain
 * `vite dev` has no /api routes at all, so this throws rather than 404s — and
 * the answer is the same either way, which is "not from here".
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

export async function listVoices(key: string, signal?: AbortSignal): Promise<Voice[]> {
  if (isMockEnabled()) return mockVoices().voices

  const response = await elevenFetch('/v1/voices', key, { signal })
  const body = (await response.json()) as VoicesResponse
  return body.voices ?? []
}

/**
 * Finds a model that can actually do voice conversion.
 *
 * Asking the API rather than hardcoding an ID means this keeps working when
 * ElevenLabs retires or renames a model, which they do periodically.
 */
export async function findConversionModel(key: string, signal?: AbortSignal): Promise<string> {
  if (isMockEnabled()) return 'eleven_multilingual_sts_v2'

  try {
    const response = await elevenFetch('/v1/models', key, { signal })
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
  key: string
  voiceId: string
  audio: Blob
  modelId?: string
  /** 0–1. Higher removes more background noise but can soften delivery. */
  removeBackgroundNoise?: boolean
  signal?: AbortSignal
}

/** Converts a recording into the chosen voice, returning the new audio. */
export async function convertVoice({
  key,
  voiceId,
  audio,
  modelId,
  removeBackgroundNoise = false,
  signal,
}: ConvertOptions): Promise<Blob> {
  if (isMockEnabled()) return mockConvert(audio)

  const model = modelId ?? (await findConversionModel(key, signal))

  const form = new FormData()
  // The extension matters: ElevenLabs sniffs the container from the filename
  // as well as the bytes.
  form.append('audio', audio, filenameFor(audio.type))
  form.append('model_id', model)
  form.append('remove_background_noise', String(removeBackgroundNoise))

  const response = await elevenFetch(`/v1/speech-to-speech/${encodeURIComponent(voiceId)}`, key, {
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
 * Empty is the default and it means *do not name one*. A clip that says a line
 * in English and then again in Spanish is two languages in one breath, and
 * naming either of them makes the model read the other one with the wrong
 * mouth — which is the exact fault this feature exists to remove.
 */
export const VOICE_LANGUAGES = [
  { code: '', label: 'Detect from the text' },
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

/**
 * Models that accept `language_code`, best first.
 *
 * ElevenLabs answers a language on a model that cannot enforce one with a 422
 * rather than by ignoring it, so this cannot be a preference — it is the set of
 * models that may be used at all once a language has been named.
 */
const ENFORCING_MODELS = ['eleven_turbo_v2_5', 'eleven_flash_v2_5']

/**
 * Models used when no language is named, best first.
 *
 * Multilingual v2 leads because it reads mixed text as it is written: an
 * English sentence followed by an Italian one comes out with two accents, which
 * is what the clips this exists for are actually saying.
 */
const DETECTING_MODELS = ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5']

/**
 * Picks a model that can speak, and can speak the language asked for.
 *
 * Asked of the API rather than hardcoded, for the reason `findConversionModel`
 * gives: model IDs come and go, and an account's plan decides which of them it
 * may use. The list is also the only place that knows whether a model has the
 * language at all, which is worth catching here — before a request is spent
 * finding out.
 */
export async function findSpeechModel(
  key: string,
  languageCode?: string,
  signal?: AbortSignal,
): Promise<string> {
  const wanted = languageCode ? ENFORCING_MODELS : DETECTING_MODELS
  if (isMockEnabled()) return wanted[0] as string

  try {
    const response = await elevenFetch('/v1/models', key, { signal })
    const models = (await response.json()) as ModelsResponse[]
    const speaks = (model: ModelsResponse) =>
      model.can_do_text_to_speech !== false &&
      (!languageCode ||
        // A model with no language list is taken at its word rather than ruled
        // out: the field is informational, and an empty one is far more likely
        // to mean the response has changed shape than that the model is mute.
        !model.languages?.length ||
        model.languages.some((entry) => entry.language_id === languageCode))

    const capable = wanted.find((id) =>
      models.some((model) => model.model_id === id && speaks(model)),
    )
    if (capable) return capable
  } catch {
    // Fall through to the documented default rather than failing the whole run
    // just because the model list could not be read.
  }
  return wanted[0] as string
}

export interface SpeakOptions {
  key: string
  /** Whose voice says it. A cloned voice is just another id here. */
  voiceId: string
  text: string
  modelId?: string
  /** ISO-639-1. Leave unset to let the model read the language off the text. */
  languageCode?: string
  signal?: AbortSignal
}

/**
 * Says a line, returning the audio.
 *
 * MP3 at 44.1kHz: the timeline mixes and exports it like any other audio, and
 * this is the format every browser this app runs in can decode without help.
 */
export async function speak({
  key,
  voiceId,
  text,
  modelId,
  languageCode,
  signal,
}: SpeakOptions): Promise<Blob> {
  if (isMockEnabled()) return mockSpeech(text)

  const model = modelId ?? (await findSpeechModel(key, languageCode, signal))

  const response = await elevenFetch(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    key,
    {
      method: 'POST',
      body: JSON.stringify({
        text,
        model_id: model,
        ...(languageCode ? { language_code: languageCode } : {}),
      }),
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      signal,
    },
  )

  return await response.blob()
}

export interface CloneOptions {
  key: string
  /** What the voice is called in the user's account while it exists. */
  name: string
  /** Audio of the voice to copy. */
  sample: Blob
  signal?: AbortSignal
}

/**
 * The current path for instant cloning, and the one it replaced.
 *
 * Tried in this order because the newer endpoint is the documented one and the
 * older one is still answering for accounts and proxies that have not caught up.
 * Only a "no such endpoint" answer moves on to the next: a rejected key or a
 * plan without cloning is a settled answer, and asking a second URL the same
 * question would only bury it behind a second error.
 */
const CLONE_PATHS = ['/v1/voices/ivc/create', '/v1/voices/add']

/**
 * Copies a voice from a sample, returning the new voice's id.
 *
 * Instant cloning, which is what makes a fixed line sound like the clip it is
 * standing in for rather than like a stranger dubbed over it. The voice is
 * created in the user's own ElevenLabs account, so whoever asks for one is
 * expected to `deleteVoice` it again — see `clipAudioFix.ts`, which does.
 */
export async function cloneVoice({ key, name, sample, signal }: CloneOptions): Promise<string> {
  if (isMockEnabled()) return mockClonedVoiceId()

  const form = new FormData()
  form.append('name', name)
  // The extension matters here for the same reason it does in conversion:
  // ElevenLabs sniffs the container from the filename as well as the bytes.
  form.append('files', sample, filenameFor(sample.type))
  form.append('remove_background_noise', 'true')

  let lastError: unknown
  for (const path of CLONE_PATHS) {
    try {
      const response = await elevenFetch(path, key, { method: 'POST', body: form, signal })
      const body = (await response.json()) as { voice_id?: string }
      if (!body.voice_id) throw new Error('ElevenLabs cloned the voice but did not name it.')
      return body.voice_id
    } catch (cause) {
      lastError = cause
      const missing =
        cause instanceof ProviderError && (cause.status === 404 || cause.status === 405)
      if (!missing) throw cause
    }
  }
  throw lastError
}

/** Removes a voice from the user's account. Used to clean up a clone. */
export async function deleteVoice(key: string, voiceId: string): Promise<void> {
  if (isMockEnabled()) return
  await elevenFetch(`/v1/voices/${encodeURIComponent(voiceId)}`, key, { method: 'DELETE' })
}

function filenameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'take.webm'
  if (mimeType.includes('ogg')) return 'take.ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'take.m4a'
  if (mimeType.includes('wav')) return 'take.wav'
  return 'take.mp3'
}

/** Cheap credential check for the "test connection" button in Settings. */
export async function verifyKey(key: string, signal?: AbortSignal): Promise<boolean> {
  if (isMockEnabled()) return true
  await elevenFetch('/v1/user', key, { signal })
  return true
}
