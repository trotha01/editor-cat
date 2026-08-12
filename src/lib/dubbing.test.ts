import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  alignWords,
  createDubbingProject,
  createLanguageTarget,
  createSegment,
  deleteSegment,
  dubbingTranscript,
  updateSegments,
  waitForDub,
  waitForTranscript,
} from './dubbing'
import { ProviderError, toDisplayMessage } from './errors'

vi.mock('./auth0/client', () => ({ auth0Token: () => Promise.resolve('session-token') }))

/**
 * The wire, pinned down.
 *
 * Worth asserting at this level more than most things in this app, because none
 * of it could be tried from the sandbox it was written in — elevenlabs.io is
 * unreachable from there, so every path and field name came from the API
 * reference and from ElevenLabs' own generated SDK rather than from a response.
 * These tests are what say the code matches what was read: a project is created
 * with `source_language` and no target, segments are rewritten in one bulk
 * PATCH keyed by id, and times are `start_s`/`end_s`.
 *
 * One run against a deploy preview did reach the API, on the older *resource*
 * API this used to call. It settled two things worth keeping: an audio-only WAV
 * upload works and the ownership marker survives a round trip — and the segment
 * endpoints there answered `401 no_dubbing_api_access`, which is why this file
 * now calls the project API instead and why the last suite exists.
 */

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const lastCall = () => fetchMock.mock.calls.at(-1) ?? []
const lastBody = () => JSON.parse(String(lastCall()[1]?.body)) as Record<string, unknown>

/** A source transcript as the API returns one. */
const TRANSCRIPT = {
  language: 'es',
  revision: 3,
  segments: [
    { id: 'seg_a', text: 'buenos dias', speaker_id: 'sp_1', start_s: 0, end_s: 1.8 },
    { id: 'seg_b', text: 'como estas', speaker_id: 'sp_1', start_s: 2, end_s: 3.5 },
  ],
}

describe('createDubbingProject', () => {
  it('sends the clip as a file, in one named language, with no target yet', async () => {
    fetchMock.mockResolvedValue(json({ project_id: 'proj_1', status: 'preparing', revision: 0 }))

    const id = await createDubbingProject({
      audio: new Blob(['wav'], { type: 'audio/wav' }),
      reference: 'editor-cat fix · lighthouse.mp4',
      language: 'es',
      seconds: 8,
    })

    expect(id).toBe('proj_1')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/project')
    const form = lastCall()[1]?.body as FormData
    expect(form.get('source_language')).toBe('es')
    // The API's own "identify this on your end" field, which is what the proxy
    // reads back before it will delete anything.
    expect(form.get('reference')).toBe('editor-cat fix · lighthouse.mp4')
    // The extension is what ElevenLabs sniffs the container from.
    expect((form.get('file') as File).name).toMatch(/\.wav$/)
    // The one that would quietly ruin everything. `target_language` here is a
    // shortcut that queues the dub to start as soon as transcription finishes —
    // which is before the captions have been written into the segments, so it
    // would say the transcriber's words and then go stale.
    expect(form.has('target_language')).toBe(false)
  })

  it('refuses a reply with no project id rather than polling nothing', async () => {
    fetchMock.mockResolvedValue(json({ status: 'preparing' }))
    await expect(
      createDubbingProject({
        audio: new Blob(['wav']),
        reference: 'r',
        language: 'es',
        seconds: 8,
      }),
    ).rejects.toThrow(/did not name it/)
  })
})

describe('dubbingTranscript', () => {
  it('reads the segments, their speakers and their spans', async () => {
    fetchMock.mockResolvedValue(json(TRANSCRIPT))

    const transcript = await dubbingTranscript('proj_1')

    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/project/proj_1/transcript')
    expect(transcript.revision).toBe(3)
    expect(transcript.segments[0]).toEqual({
      id: 'seg_a',
      text: 'buenos dias',
      speakerId: 'sp_1',
      start: 0,
      end: 1.8,
    })
  })

  it('survives a transcript with nothing in it yet', async () => {
    fetchMock.mockResolvedValue(json({ revision: 0 }))
    expect((await dubbingTranscript('proj_1')).segments).toEqual([])
  })
})

describe('waitForTranscript', () => {
  it('waits out the transcription, then hands back what it found', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ project_id: 'proj_1', status: 'preparing' }))
      .mockResolvedValueOnce(json({ project_id: 'proj_1', status: 'processing' }))
      .mockResolvedValueOnce(json({ project_id: 'proj_1', status: 'ready' }))
      .mockResolvedValueOnce(json(TRANSCRIPT))

    const transcript = await waitForTranscript('proj_1')

    expect(transcript.segments).toHaveLength(2)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/elevenlabs/v1/dubbing/project/proj_1',
      '/api/elevenlabs/v1/dubbing/project/proj_1',
      '/api/elevenlabs/v1/dubbing/project/proj_1',
      '/api/elevenlabs/v1/dubbing/project/proj_1/transcript',
    ])
  })

  it('reports what the provider said when the project failed', async () => {
    fetchMock.mockResolvedValue(
      json({ project_id: 'proj_1', status: 'failed', error: { message: 'no speech detected' } }),
    )
    const error = await waitForTranscript('proj_1').catch((cause: unknown) => cause)
    expect(toDisplayMessage(error)).toMatch(/could not prepare/i)
    expect(toDisplayMessage(error)).toMatch(/no speech detected/)
  })

  it('treats a ready project with no segments as a failure, not as a result', async () => {
    // Ready is not the same as there being something to edit, and a run that
    // carried on from here would dub silence.
    fetchMock
      .mockResolvedValueOnce(json({ project_id: 'proj_1', status: 'ready' }))
      .mockResolvedValueOnce(json({ revision: 0, segments: [] }))

    await expect(waitForTranscript('proj_1')).rejects.toThrow(/nothing being said/i)
  })

  it('stops waiting the moment Cancel is pressed', async () => {
    fetchMock.mockResolvedValue(json({ project_id: 'proj_1', status: 'processing' }))
    const controller = new AbortController()
    const waiting = waitForTranscript('proj_1', { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow(/abort/i)
  })
})

describe('writing the script onto the segments', () => {
  it('rewrites every segment in one request, keyed by id', async () => {
    // One request rather than one each: they are one script being written in,
    // so they go together and bump the revision once.
    fetchMock.mockResolvedValue(json({ revision: 4 }))

    await updateSegments('proj_1', {
      seg_a: { start: 0, end: 1.8, text: 'Buenos días' },
      seg_b: { start: 2, end: 3.5, text: '¿Cómo estás?' },
    })

    const [url, init] = lastCall()
    expect(url).toBe('/api/elevenlabs/v1/dubbing/project/proj_1/transcript/segments')
    expect(init?.method).toBe('PATCH')
    expect(lastBody()).toEqual({
      segments: {
        seg_a: { text: 'Buenos días', start_s: 0, end_s: 1.8 },
        seg_b: { text: '¿Cómo estás?', start_s: 2, end_s: 3.5 },
      },
    })
  })

  it('spends no request at all when there is nothing to rewrite', async () => {
    await updateSegments('proj_1', {})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adds a span the transcription missed, under a speaker that exists', async () => {
    fetchMock.mockResolvedValue(json({ segment_id: 'seg_new', revision: 5 }))

    const id = await createSegment('proj_1', 'sp_1', { start: 4, end: 5, text: 'Adiós' })

    expect(id).toBe('seg_new')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/project/proj_1/transcript/segment')
    expect(lastBody()).toEqual({
      text: 'Adiós',
      speaker_id: 'sp_1',
      start_s: 4,
      end_s: 5,
    })
  })

  it('drops a span the captions do not have', async () => {
    fetchMock.mockResolvedValue(json({ revision: 6 }))

    await deleteSegment('proj_1', 'seg_b')

    const [url, init] = lastCall()
    expect(url).toBe('/api/elevenlabs/v1/dubbing/project/proj_1/transcript/segment/seg_b')
    expect(init?.method).toBe('DELETE')
  })
})

describe('saying it again', () => {
  it('adds a language target in the same language, which is what starts it', async () => {
    // Same in and out. This is a re-voicing, not a translation: the captions are
    // already the user's words, sitting in the segments.
    fetchMock.mockResolvedValue(json({ language_id: 'lang_1', status: 'queued' }))

    const languageId = await createLanguageTarget('proj_1', 'es')

    expect(languageId).toBe('lang_1')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/project/proj_1/language')
    expect(lastBody()).toEqual({ target_language: 'es' })
  })

  it('waits for the dub and returns where to download it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ language_id: 'lang_1', status: 'queued' }))
      .mockResolvedValueOnce(json({ language_id: 'lang_1', status: 'processing' }))
      .mockResolvedValueOnce(
        json({
          language_id: 'lang_1',
          status: 'completed',
          outputs: { lossless_audio: 'https://signed.example/dub.wav' },
        }),
      )

    expect(await waitForDub('proj_1', 'lang_1')).toBe('https://signed.example/dub.wav')
  })

  it('refuses a dub that no longer matches the script it was made from', async () => {
    // `stale` means the transcript changed after the audio was made, so what is
    // heard and what is burnt into the video would disagree — which is the one
    // thing this whole feature exists to prevent. Better to fail than to lay it
    // down.
    fetchMock.mockResolvedValue(
      json({
        language_id: 'lang_1',
        status: 'stale',
        revision: 7,
        output_revision: 4,
        outputs: { lossless_audio: 'https://signed.example/old.wav' },
      }),
    )
    await expect(waitForDub('proj_1', 'lang_1')).rejects.toThrow(/no longer matches/i)
  })

  it('does not call a completed target with no output a success', async () => {
    fetchMock.mockResolvedValue(json({ language_id: 'lang_1', status: 'completed' }))
    await expect(waitForDub('proj_1', 'lang_1')).rejects.toThrow(/returned no audio/i)
  })

  it('reports what the provider said when the dub failed', async () => {
    fetchMock.mockResolvedValue(
      json({ language_id: 'lang_1', status: 'failed', error: { message: 'voice not permitted' } }),
    )
    const error = await waitForDub('proj_1', 'lang_1').catch((cause: unknown) => cause)
    expect(toDisplayMessage(error)).toMatch(/voice not permitted/)
  })
})

describe('alignWords', () => {
  it('sends the finished track and the script, and returns the words timed', async () => {
    // The one thing dubbing does not hand back: its transcript is timed per
    // segment and no finer, so without this the karaoke highlight has nothing
    // to follow.
    fetchMock.mockResolvedValue(
      json({
        words: [
          { text: 'Buenos', start: 0.1, end: 0.6, loss: 0.1 },
          { text: 'días', start: 0.6, end: 1.1, loss: 0.1 },
          { text: ' ', start: 1.1, end: 1.1, loss: 0 },
        ],
        loss: 0.1,
      }),
    )

    const words = await alignWords(new Blob(['mp3']), 'Buenos días')

    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/forced-alignment')
    expect((lastCall()[1]?.body as FormData).get('text')).toBe('Buenos días')
    // Whitespace is nobody's word, exactly as it was under the timestamps
    // endpoint this replaced.
    expect(words).toEqual([
      { text: 'Buenos', start: 0.1, end: 0.6 },
      { text: 'días', start: 0.6, end: 1.1 },
    ])
  })

  it('says nothing rather than guessing when nothing came back', async () => {
    fetchMock.mockResolvedValue(json({ loss: 0 }))
    expect(await alignWords(new Blob(['mp3']), 'Hola')).toEqual([])
  })
})

describe('when the workspace is not entitled to segment editing', () => {
  it('names the refusal the project API actually gives, on the call that gives it', async () => {
    // Verbatim from a live run. This is the expensive shape: the project was
    // created and its transcript read, both fine, and only the rewrite — the
    // one call the whole feature is built on — came back refused. A bare 403
    // reads as "this deployment is misconfigured", which is the wrong thing to
    // go and check.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            type: 'authorization_error',
            code: 'feature_not_available',
            message: 'Dubbing project editing is not enabled for your workspace.',
            status: 'feature_not_available',
          },
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json', 'x-elevenlabs-status': '403' },
        },
      ),
    )

    const error = await updateSegments('proj_1', {
      seg_a: { start: 0, end: 1, text: 'Buenos días' },
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProviderError)
    expect(toDisplayMessage(error)).toMatch(/does not have dubbing project editing enabled/i)
    // What it cost, and what to do — neither of which is "try again".
    expect(toDisplayMessage(error)).toMatch(/uploaded and transcribed before the refusal/i)
    expect(toDisplayMessage(error)).toMatch(/enable dubbing project editing/i)
  })

  it('says so on the older API’s refusal too, instead of telling the user to sign in again', async () => {
    // Verbatim from a live run, including the `x-elevenlabs-status` the proxy
    // adds to say the 401 is ElevenLabs' and not this site's session check.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            type: 'authorization_error',
            code: 'forbidden',
            message:
              'This API is in closed-beta and is only available to workspaces that are granted access.',
            status: 'no_dubbing_api_access',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-elevenlabs-status': '401' },
        },
      ),
    )

    // Caught once rather than awaited twice: a Response body can only be read
    // through the once, so asking the mock for the same one again would hand
    // back a spent stream and a much vaguer error than the code really gives.
    const error = await dubbingTranscript('proj_1').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProviderError)
    expect(toDisplayMessage(error)).toMatch(/does not have dubbing project editing enabled/i)
    // And the way out, which is not "try again" and not "sign in".
    expect(toDisplayMessage(error)).toMatch(/enable dubbing project editing/i)
    expect(toDisplayMessage(error)).not.toMatch(/sign in/i)
  })

  it('leaves every other refusal to say what it already says', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: { message: 'quota exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-elevenlabs-status': '429' },
      }),
    )
    await expect(dubbingTranscript('proj_1')).rejects.toThrow(/rate limit/i)
  })
})
