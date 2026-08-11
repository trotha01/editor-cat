import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneVoice, deleteVoice, findSpeechModel, speak, siteProvidesKey } from './elevenlabs'

vi.mock('./auth0/client', () => ({ auth0Token: () => Promise.resolve('session-token') }))

/**
 * The provider calls behind fixing a clip's pronunciation.
 *
 * Worth pinning down at this level because every one of them is a request whose
 * shape decides whether the whole feature works or returns a 422: which model
 * may be sent a language at all, which URL instant cloning lives at this month,
 * and that a copied voice is asked for as a file rather than as JSON.
 */

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const audio = () => new Response('mp3-bytes', { headers: { 'content-type': 'audio/mpeg' } })

/** The models list as ElevenLabs returns it, trimmed to what is read. */
const MODELS = [
  {
    model_id: 'eleven_multilingual_v2',
    can_do_text_to_speech: true,
    languages: [{ language_id: 'it' }],
  },
  {
    model_id: 'eleven_turbo_v2_5',
    can_do_text_to_speech: true,
    languages: [{ language_id: 'it' }, { language_id: 'es' }],
  },
]

describe('who pays', () => {
  it('sends no key at all when the site is providing one', async () => {
    fetchMock.mockResolvedValue(json({ voices: [] }))

    await deleteVoice('', 'cloned')

    const headers = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers)
    expect(headers.has('xi-api-key')).toBe(false)
    // What the proxy checks before it spends the site's key on anybody.
    expect(headers.get('authorization')).toBe('Bearer session-token')
  })

  it('forwards a key the user entered, which is what makes it theirs', async () => {
    fetchMock.mockResolvedValue(json({ voices: [] }))

    await deleteVoice('  their-own-key  ', 'cloned')

    const headers = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers)
    expect(headers.get('xi-api-key')).toBe('their-own-key')
  })

  it('reads the deployment’s answer once and remembers it', async () => {
    fetchMock.mockResolvedValue(json({ configured: true }))

    expect(await siteProvidesKey()).toBe(true)
    expect(await siteProvidesKey()).toBe(true)
    // A property of the build on the other end, not of the moment.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/elevenlabs/status')
  })

  it('says no rather than throwing where there are no functions at all', async () => {
    // Plain `vite dev` serves no /api routes, so this rejects rather than 404s.
    vi.resetModules()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const fresh = await import('./elevenlabs')
    expect(await fresh.siteProvidesKey()).toBe(false)
  })
})

describe('findSpeechModel', () => {
  it('picks a model that can be told which language to speak, when one was chosen', async () => {
    fetchMock.mockResolvedValue(json(MODELS))
    // Multilingual v2 is the better model and comes first in the account's
    // list, but it answers a language_code with a 422 rather than obeying it.
    expect(await findSpeechModel('k', 'it')).toBe('eleven_turbo_v2_5')
  })

  it('prefers the model that reads mixed text when no language was named', async () => {
    fetchMock.mockResolvedValue(json(MODELS))
    expect(await findSpeechModel('k')).toBe('eleven_multilingual_v2')
  })

  it('passes over a model that does not speak the language asked for', async () => {
    fetchMock.mockResolvedValue(
      json([{ model_id: 'eleven_turbo_v2_5', languages: [{ language_id: 'en' }] }]),
    )
    // Nothing in the account speaks Japanese, so the documented default stands
    // rather than a model picked for being present.
    expect(await findSpeechModel('k', 'ja')).toBe('eleven_turbo_v2_5')
  })

  it('falls back rather than failing when the model list cannot be read', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'nope' }, 500))
    expect(await findSpeechModel('k')).toBe('eleven_multilingual_v2')
  })
})

describe('speak', () => {
  it('sends the line, the model and the language, and asks for MP3 back', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(audio())

    const result = await speak({ key: 'k', voiceId: 'v1', text: 'Buongiorno', languageCode: 'it' })

    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    expect(url).toContain('/api/elevenlabs/v1/text-to-speech/v1')
    expect(url).toContain('output_format=mp3')
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'Buongiorno',
      model_id: 'eleven_turbo_v2_5',
      language_code: 'it',
    })
    expect(result.type).toBe('audio/mpeg')
  })

  it('leaves the language out entirely when none was chosen', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(audio())

    await speak({ key: 'k', voiceId: 'v1', text: 'Hello' })

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty('language_code')
  })

  it('spends no request on finding a model when it was given one', async () => {
    fetchMock.mockResolvedValue(audio())

    await speak({ key: 'k', voiceId: 'v1', text: 'Hello', modelId: 'eleven_flash_v2_5' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('cloneVoice', () => {
  it('sends the sample as a file and returns the new voice', async () => {
    fetchMock.mockResolvedValue(json({ voice_id: 'cloned' }))

    const voiceId = await cloneVoice({
      key: 'k',
      name: 'editor-cat fix · lighthouse.mp4',
      sample: new Blob(['wav'], { type: 'audio/wav' }),
    })

    expect(voiceId).toBe('cloned')
    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    expect(url).toBe('/api/elevenlabs/v1/voices/ivc/create')
    const form = init?.body as FormData
    expect(form.get('name')).toBe('editor-cat fix · lighthouse.mp4')
    // The extension is what ElevenLabs sniffs the container from.
    expect((form.get('files') as File).name).toMatch(/\.wav$/)
  })

  it('tries the endpoint this replaced when the current one is not there', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ voice_id: 'cloned' }))

    expect(await cloneVoice({ key: 'k', name: 'n', sample: new Blob(['wav']) })).toBe('cloned')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/elevenlabs/v1/voices/ivc/create',
      '/api/elevenlabs/v1/voices/add',
    ])
  })

  it('does not ask a second URL about a rejected key', async () => {
    // A settled answer. Asking again would only bury it behind a second error.
    fetchMock.mockResolvedValue(json({ detail: { message: 'invalid key' } }, 401))

    await expect(cloneVoice({ key: 'k', name: 'n', sample: new Blob(['wav']) })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('deleteVoice', () => {
  it('removes the copy from the account', async () => {
    fetchMock.mockResolvedValue(json({ status: 'ok' }))

    await deleteVoice('k', 'cloned')

    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    expect(url).toBe('/api/elevenlabs/v1/voices/cloned')
    expect(init?.method).toBe('DELETE')
  })
})
