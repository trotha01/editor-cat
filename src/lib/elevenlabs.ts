/**
 * ElevenLabs: the voice changer.
 *
 * Takes a microphone recording and re-performs it in a different voice, keeping
 * the timing and delivery of the original. This is the one thing the user's own
 * key pays for, which is why it is the only thing left here — captions used to
 * call ElevenLabs directly too, and now reach the same company's Scribe through
 * fal, on this deployment's account. See `scribe.ts`.
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
