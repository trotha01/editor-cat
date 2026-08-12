import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cloneVoice,
  deleteVoice,
  findSpeechModel,
  speak,
  siteProvidesKey,
  wordsFromAlignment,
} from './elevenlabs'

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

/**
 * The with-timestamps endpoint's shape: base64 audio, plus a start and an end
 * for every character in the text as it was sent.
 */
const spoken = (text = 'Hi there', from = 0, step = 0.1) =>
  json({
    audio_base64: btoa('mp3-bytes'),
    alignment: {
      characters: [...text],
      character_start_times_seconds: [...text].map((_, index) => from + index * step),
      character_end_times_seconds: [...text].map((_, index) => from + (index + 1) * step),
    },
  })

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
  it('sends the session and no key at all', async () => {
    // The browser has no ElevenLabs credential to send. What it has is proof of
    // who is asking, which is what the proxy checks before attaching the site's.
    fetchMock.mockResolvedValue(json({ voices: [] }))

    await deleteVoice('cloned')

    const headers = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers)
    expect(headers.has('xi-api-key')).toBe(false)
    expect(headers.get('authorization')).toBe('Bearer session-token')
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
    expect(await findSpeechModel('it')).toBe('eleven_turbo_v2_5')
  })

  it('prefers the model that reads mixed text when no language was named', async () => {
    fetchMock.mockResolvedValue(json(MODELS))
    expect(await findSpeechModel()).toBe('eleven_multilingual_v2')
  })

  it('passes over a model that does not speak the language asked for', async () => {
    fetchMock.mockResolvedValue(
      json([{ model_id: 'eleven_turbo_v2_5', languages: [{ language_id: 'en' }] }]),
    )
    // Nothing in the account speaks Japanese, so the documented default stands
    // rather than a model picked for being present.
    expect(await findSpeechModel('ja')).toBe('eleven_turbo_v2_5')
  })

  it('falls back rather than failing when the model list cannot be read', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'nope' }, 500))
    expect(await findSpeechModel()).toBe('eleven_multilingual_v2')
  })
})

describe('wordsFromAlignment', () => {
  it('groups characters into words and leaves the spaces to nobody', () => {
    const words = wordsFromAlignment({
      characters: ['H', 'i', ' ', 'y', 'o', 'u'],
      character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
      character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    })

    expect(words).toEqual([
      { text: 'Hi', start: 0, end: 0.2 },
      { text: 'you', start: 0.3, end: 0.6 },
    ])
  })

  it('keeps punctuation on the word it follows, as the caption spells it', () => {
    const characters = [...'Ciao, bella!']
    const words = wordsFromAlignment({
      characters,
      character_start_times_seconds: characters.map((_, index) => index * 0.1),
      character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.1),
    })
    expect(words.map((word) => word.text)).toEqual(['Ciao,', 'bella!'])
  })

  it('says nothing rather than guessing when there is no alignment', () => {
    expect(wordsFromAlignment(undefined)).toEqual([])
    expect(wordsFromAlignment({})).toEqual([])
  })
})

describe('speak', () => {
  it('asks the timestamps endpoint, and returns the audio with its word timings', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(spoken('Ciao bella'))

    const result = await speak({ voiceId: 'v1', text: 'Ciao bella', languageCode: 'it' })

    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    // The timings are the whole point: without them the captions cannot be
    // moved onto the speech afterwards.
    expect(url).toContain('/api/elevenlabs/v1/text-to-speech/v1/with-timestamps')
    expect(url).toContain('output_format=mp3')
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'Ciao bella',
      model_id: 'eleven_turbo_v2_5',
      language_code: 'it',
    })
    expect(result.blob.type).toBe('audio/mpeg')
    expect(result.words.map((word) => word.text)).toEqual(['Ciao', 'bella'])
    expect(result.words[0]?.start).toBe(0)
  })

  it('carries the lines either side, so a passage does not read as a list', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(spoken())

    await speak({
      voiceId: 'v1',
      text: 'And then?',
      previousText: 'It was raining.',
      nextText: 'Nothing at all.',
    })

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<
      string,
      unknown
    >
    expect(body.previous_text).toBe('It was raining.')
    expect(body.next_text).toBe('Nothing at all.')
  })

  it('leaves the language out entirely when none was chosen', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(spoken())

    await speak({ voiceId: 'v1', text: 'Hello' })

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty('language_code')
    expect(body).not.toHaveProperty('previous_text')
  })

  it('spends no request on finding a model when it was given one', async () => {
    fetchMock.mockResolvedValue(spoken())

    await speak({ voiceId: 'v1', text: 'Hello', modelId: 'eleven_flash_v2_5' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a reply with no audio in it rather than laying down silence', async () => {
    fetchMock.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(json({ alignment: {} }))

    await expect(speak({ voiceId: 'v1', text: 'Hello' })).rejects.toThrow(/no audio/i)
  })
})

describe('cloneVoice', () => {
  it('sends the sample as a file and returns the new voice', async () => {
    fetchMock.mockResolvedValue(json({ voice_id: 'cloned' }))

    const voiceId = await cloneVoice({
      name: 'editor-cat fix · lighthouse.mp4',
      sample: new Blob(['wav'], { type: 'audio/wav' }),
    })

    expect(voiceId).toBe('cloned')
    // One request, because the path tried first is the one that answers. It was
    // the other way round until a deploy showed `ivc/create` answering 405 to
    // every clone, which cost a wasted round trip on each one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    expect(url).toBe('/api/elevenlabs/v1/voices/add')
    const form = init?.body as FormData
    expect(form.get('name')).toBe('editor-cat fix · lighthouse.mp4')
    // The extension is what ElevenLabs sniffs the container from.
    expect((form.get('files') as File).name).toMatch(/\.wav$/)
  })

  it('tries the other endpoint when the first one is not there', async () => {
    // Either of these two can be the one that has gone: `add` is the deprecated
    // half and `ivc/create` is the half that 405s today, so the fallback is not
    // a nicety — it is what stops the order in this file from being a release.
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ voice_id: 'cloned' }))

    expect(await cloneVoice({ name: 'n', sample: new Blob(['wav']) })).toBe('cloned')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/elevenlabs/v1/voices/add',
      '/api/elevenlabs/v1/voices/ivc/create',
    ])
  })

  it('moves on from a 405 as readily as from a 404', async () => {
    // The answer the live API actually gives for a path that is not there.
    fetchMock
      .mockResolvedValueOnce(json({ detail: 'Method Not Allowed' }, 405))
      .mockResolvedValueOnce(json({ voice_id: 'cloned' }))

    expect(await cloneVoice({ name: 'n', sample: new Blob(['wav']) })).toBe('cloned')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not ask a second URL about a rejected key', async () => {
    // A settled answer. Asking again would only bury it behind a second error.
    fetchMock.mockResolvedValue(json({ detail: { message: 'invalid key' } }, 401))

    await expect(cloneVoice({ name: 'n', sample: new Blob(['wav']) })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('deleteVoice', () => {
  it('removes the copy from the account', async () => {
    fetchMock.mockResolvedValue(json({ status: 'ok' }))

    await deleteVoice('cloned')

    const [url, init] = fetchMock.mock.calls.at(-1) ?? []
    expect(url).toBe('/api/elevenlabs/v1/voices/cloned')
    expect(init?.method).toBe('DELETE')
  })
})
