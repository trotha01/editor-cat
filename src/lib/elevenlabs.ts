/**
 * ElevenLabs: the voice changer, and the transcriber behind captions.
 *
 * The voice changer takes a microphone recording and re-performs it in a
 * different voice, keeping the timing and delivery of the original.
 *
 * Transcription is Scribe, and it is here rather than behind some other provider
 * for one reason: it returns a timestamp per *word*, which is the whole
 * requirement for karaoke captions. A transcript with only sentence-level
 * timings would have to have its word timings guessed, and guessed word timings
 * are exactly what a highlight moving across the line makes obvious.
 *
 * All traffic goes through /api/elevenlabs so we do not depend on ElevenLabs'
 * browser CORS policy.
 */
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
}

async function elevenFetch(path: string, key: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${PROXY_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'xi-api-key': key },
  })
  if (!response.ok) throw await providerErrorFrom('ElevenLabs', response)
  return response
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

/** The Scribe model. Named explicitly so a transcription is reproducible. */
export const TRANSCRIPTION_MODEL = 'scribe_v1'

/**
 * One entry of Scribe's word list.
 *
 * `type` matters: the list interleaves real words with the spacing between them
 * and, when asked, with audio events like `(laughter)`. Only `word` entries are
 * words, and taking the rest would put punctuation-shaped captions on screen.
 */
interface ScribeWord {
  text: string
  start?: number
  end?: number
  type?: 'word' | 'spacing' | 'audio_event'
}

interface ScribeResponse {
  text?: string
  language_code?: string
  words?: ScribeWord[]
}

export interface TranscriptionResult {
  /** Words in spoken order, timed in seconds from the start of the file. */
  words: { text: string; start: number; end: number }[]
  /** What Scribe detected, e.g. "eng". Shown so a mis-detection is visible. */
  languageCode?: string
}

export interface TranscribeOptions {
  key: string
  audio: Blob
  /**
   * ISO-639 code to transcribe as. Left unset, Scribe detects it — which is
   * right nearly always, and wrong in a way worth being able to override on
   * short or noisy takes.
   */
  languageCode?: string
  signal?: AbortSignal
}

/**
 * Transcribes one piece of audio, with a timestamp on every word.
 *
 * Words with no timing are dropped rather than defaulted to zero: a word with no
 * time cannot be highlighted at the right moment, and one silently pinned to the
 * start of the clip is worse than one that is missing.
 */
export async function transcribe({
  key,
  audio,
  languageCode,
  signal,
}: TranscribeOptions): Promise<TranscriptionResult> {
  const form = new FormData()
  form.append('file', audio, filenameFor(audio.type))
  form.append('model_id', TRANSCRIPTION_MODEL)
  // Word-level timestamps are what this is for; ask for them explicitly rather
  // than relying on the default staying what it is today.
  form.append('timestamps_granularity', 'word')
  form.append('diarize', 'false')
  if (languageCode) form.append('language_code', languageCode)

  const response = await elevenFetch('/v1/speech-to-text', key, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json' },
    signal,
  })

  const body = (await response.json()) as ScribeResponse

  const words = (body.words ?? [])
    .filter((word) => (word.type ?? 'word') === 'word')
    .filter(
      (word): word is ScribeWord & { start: number; end: number } =>
        typeof word.start === 'number' && typeof word.end === 'number',
    )
    .map((word) => ({ text: word.text.trim(), start: word.start, end: word.end }))
    .filter((word) => word.text.length > 0)

  return { words, ...(body.language_code ? { languageCode: body.language_code } : {}) }
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
