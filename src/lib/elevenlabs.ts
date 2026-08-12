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

async function elevenFetch(path: string, init?: RequestInit): Promise<Response> {
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
  languageCode?: string,
  signal?: AbortSignal,
): Promise<string> {
  const wanted = languageCode ? ENFORCING_MODELS : DETECTING_MODELS
  if (isMockEnabled()) return wanted[0] as string

  try {
    const response = await elevenFetch('/v1/models', { signal })
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
  /** Whose voice says it. A cloned voice is just another id here. */
  voiceId: string
  text: string
  modelId?: string
  /** ISO-639-1. Leave unset to let the model read the language off the text. */
  languageCode?: string
  /**
   * The lines either side of this one, when a passage is being spoken a line at
   * a time.
   *
   * Not spoken and not billed — read for context only. Without them each line is
   * performed as if it were the whole utterance, so every one lands on a full
   * stop and the passage comes back as a list rather than as speech. This is
   * ElevenLabs' own answer to that, and it is why a clip cut into caption lines
   * still sounds like one person talking.
   */
  previousText?: string
  nextText?: string
  signal?: AbortSignal
}

/** A word, and when it was said, in seconds from the start of the audio. */
export interface SpokenWord {
  text: string
  start: number
  end: number
}

export interface Speech {
  /** The line, as MP3. */
  blob: Blob
  /**
   * When each word in it was said.
   *
   * The whole reason this endpoint is used rather than the plain one: nothing
   * can make a model say a word at a chosen moment, but it will say exactly when
   * it said each one — and that is enough to move the captions onto the speech
   * afterwards. See `retimeWords` in `captions.ts`.
   */
  words: SpokenWord[]
}

/** Per-character timings, as the with-timestamps endpoint returns them. */
interface Alignment {
  characters?: string[]
  character_start_times_seconds?: number[]
  character_end_times_seconds?: number[]
}

interface SpeechResponse {
  audio_base64?: string
  /** Aligned to the text as it was sent. */
  alignment?: Alignment
  /** Aligned to the text after the model's own normalisation. */
  normalized_alignment?: Alignment
}

/**
 * Groups a per-character alignment into words.
 *
 * ElevenLabs times characters, which is finer than anything here needs and
 * awkward in exactly one way: whitespace belongs to neither word. A word runs
 * from the start of its first character to the end of its last, and the spaces
 * between them are nobody's. Punctuation stays attached to the word it follows,
 * because that is how the caption it will be re-timing spells it too.
 */
export function wordsFromAlignment(alignment: Alignment | undefined): SpokenWord[] {
  const characters = alignment?.characters ?? []
  const starts = alignment?.character_start_times_seconds ?? []
  const ends = alignment?.character_end_times_seconds ?? []

  const words: SpokenWord[] = []
  let current: SpokenWord | null = null

  for (const [index, character] of characters.entries()) {
    if (/\s/.test(character)) {
      current = null
      continue
    }
    const start: number = starts[index] ?? current?.end ?? 0
    const end = ends[index] ?? start
    if (current) {
      current.text += character
      current.end = Math.max(current.end, end)
    } else {
      current = { text: character, start, end: Math.max(start, end) }
      words.push(current)
    }
  }

  return words
}

/** Base64 audio to bytes, which is how this endpoint returns it. */
function decodeAudioBase64(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: 'audio/mpeg' })
}

/**
 * Says a line, returning the audio and when each word in it was said.
 *
 * The with-timestamps endpoint rather than the plain one, which costs a base64
 * round trip and buys the only thing that can make generated speech agree with
 * captions: knowing where the words landed. MP3 at 44.1kHz, because the timeline
 * mixes and exports it like any other audio and every browser this app runs in
 * decodes that without help.
 */
export async function speak({
  voiceId,
  text,
  modelId,
  languageCode,
  previousText,
  nextText,
  signal,
}: SpeakOptions): Promise<Speech> {
  if (isMockEnabled()) return mockSpeech(text)

  const model = modelId ?? (await findSpeechModel(languageCode, signal))

  const response = await elevenFetch(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      body: JSON.stringify({
        text,
        model_id: model,
        ...(languageCode ? { language_code: languageCode } : {}),
        ...(previousText ? { previous_text: previousText } : {}),
        ...(nextText ? { next_text: nextText } : {}),
      }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal,
    },
  )

  const body = (await response.json()) as SpeechResponse
  if (!body.audio_base64) throw new Error('ElevenLabs returned no audio for that line.')

  return {
    blob: decodeAudioBase64(body.audio_base64),
    // The un-normalised alignment first: it is spelled the way the caption is,
    // so its words line up with the ones about to be re-timed. The normalised
    // one spells numbers and symbols out, which would put the words out of step.
    words: wordsFromAlignment(body.alignment ?? body.normalized_alignment),
  }
}

export interface CloneOptions {
  /** What the voice is called in the account while it exists. */
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
 * created in the deployment's ElevenLabs account, so whoever asks for one is
 * expected to `deleteVoice` it again — see `clipAudioFix.ts`, which does, and
 * `netlify/lib/elevenlabs.ts`, which sweeps up after the runs that could not.
 */
export async function cloneVoice({ name, sample, signal }: CloneOptions): Promise<string> {
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
      const response = await elevenFetch(path, { method: 'POST', body: form, signal })
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

/** Removes a voice from the account. Used to clean up a clone. */
export async function deleteVoice(voiceId: string): Promise<void> {
  if (isMockEnabled()) return
  await elevenFetch(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
}

function filenameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'take.webm'
  if (mimeType.includes('ogg')) return 'take.ogg'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'take.m4a'
  if (mimeType.includes('wav')) return 'take.wav'
  return 'take.mp3'
}
