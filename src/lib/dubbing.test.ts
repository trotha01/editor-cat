import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  alignWords,
  createDub,
  createSegment,
  dubbingResource,
  dubSegments,
  renderDub,
  setSpeakerVoice,
  updateSegment,
  waitForRender,
  waitForSegments,
} from './dubbing'

vi.mock('./auth0/client', () => ({ auth0Token: () => Promise.resolve('session-token') }))

/**
 * The wire, pinned down.
 *
 * Worth asserting at this level more than most things in this app, because none
 * of it could be tried against the live API while it was written — elevenlabs.io
 * is unreachable from the sandbox this was built in, so every path and field
 * name here came from ElevenLabs' own generated SDK rather than from a response.
 * These tests are what say the code matches what was read: a segment update is a
 * PATCH with the language last in the path, a render asks for `render_type`, and
 * a resource's segments come back as a map that has to be put in order.
 *
 * They are not evidence that the API behaves as documented. That is in the PR.
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

/** A resource as the API returns one: maps, snake_case, and no order at all. */
const RESOURCE = {
  id: 'dub_1',
  source_language: 'es',
  speaker_tracks: { sp_1: { id: 'sp_1', segments: ['seg_b', 'seg_a'] } },
  speaker_segments: {
    seg_b: { id: 'seg_b', start_time: 2, end_time: 3.5, text: 'como estas' },
    seg_a: { id: 'seg_a', start_time: 0, end_time: 1.8, text: 'buenos dias' },
  },
  renders: {},
}

describe('createDub', () => {
  it('asks for an editable job in one language, as a file', async () => {
    fetchMock.mockResolvedValue(json({ dubbing_id: 'dub_1', expected_duration_sec: 8 }))

    const id = await createDub({
      audio: new Blob(['wav'], { type: 'audio/wav' }),
      name: 'editor-cat fix · lighthouse.mp4',
      language: 'es',
      seconds: 8,
    })

    expect(id).toBe('dub_1')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing')
    const form = lastCall()[1]?.body as FormData
    // Same in and out. This is a re-voicing, not a translation: the captions are
    // the script, so asking for a different target language would be asking the
    // provider to replace the user's words with its own.
    expect(form.get('source_lang')).toBe('es')
    expect(form.get('target_lang')).toBe('es')
    // Without this the job is one-shot and there are no segments to edit, which
    // is the only reason to be using dubbing rather than text-to-speech.
    expect(form.get('dubbing_studio')).toBe('true')
    expect(form.get('num_speakers')).toBe('1')
    // The extension is what ElevenLabs sniffs the container from.
    expect((form.get('file') as File).name).toMatch(/\.wav$/)
  })

  it('refuses a reply with no job id rather than polling nothing', async () => {
    fetchMock.mockResolvedValue(json({ expected_duration_sec: 8 }))
    await expect(
      createDub({ audio: new Blob(['wav']), name: 'n', language: 'es', seconds: 8 }),
    ).rejects.toThrow(/did not name it/)
  })
})

describe('dubbingResource', () => {
  it('puts the segments in time order, whatever order the map was in', async () => {
    // The wire shape is a map, and a map has no order. Everything downstream
    // pairs segments with captions by position, so this is not presentation.
    fetchMock.mockResolvedValue(json(RESOURCE))

    const resource = await dubbingResource('dub_1')

    expect(resource.segments.map((segment) => segment.id)).toEqual(['seg_a', 'seg_b'])
    expect(resource.segments[0]).toEqual({
      id: 'seg_a',
      start: 0,
      end: 1.8,
      text: 'buenos dias',
    })
    expect(resource.speakers).toEqual([{ id: 'sp_1', segments: ['seg_b', 'seg_a'] }])
    expect(resource.sourceLanguage).toBe('es')
  })

  it('survives a resource with nothing in it yet', async () => {
    fetchMock.mockResolvedValue(json({ id: 'dub_1' }))
    const resource = await dubbingResource('dub_1')
    expect(resource.segments).toEqual([])
    expect(resource.speakers).toEqual([])
  })
})

describe('waitForSegments', () => {
  it('waits out the job, then hands back what it found', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ dubbing_id: 'dub_1', status: 'dubbing' }))
      .mockResolvedValueOnce(json({ dubbing_id: 'dub_1', status: 'dubbed' }))
      .mockResolvedValueOnce(json(RESOURCE))

    const resource = await waitForSegments('dub_1')

    expect(resource.segments).toHaveLength(2)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/elevenlabs/v1/dubbing/dub_1',
      '/api/elevenlabs/v1/dubbing/dub_1',
      '/api/elevenlabs/v1/dubbing/resource/dub_1',
    ])
  })

  it('reports what the provider said when the job failed', async () => {
    fetchMock.mockResolvedValue(
      json({ dubbing_id: 'dub_1', status: 'failed', error: 'no speech detected' }),
    )
    await expect(waitForSegments('dub_1')).rejects.toThrow(/could not dub/i)
  })

  it('treats a finished job with no segments as a failure, not as a result', async () => {
    // The status having gone quiet is not the same as there being something to
    // edit, and a run that carried on from here would render silence.
    fetchMock
      .mockResolvedValueOnce(json({ dubbing_id: 'dub_1', status: 'dubbed' }))
      .mockResolvedValueOnce(json({ id: 'dub_1', speaker_segments: {} }))

    await expect(waitForSegments('dub_1')).rejects.toThrow(/nothing being said/i)
  })

  it('stops waiting the moment Cancel is pressed', async () => {
    fetchMock.mockResolvedValue(json({ dubbing_id: 'dub_1', status: 'dubbing' }))
    const controller = new AbortController()
    const waiting = waitForSegments('dub_1', { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow(/abort/i)
  })
})

describe('editing the script onto the segments', () => {
  it('puts a caption on a segment with the language last in the path', async () => {
    fetchMock.mockResolvedValue(json({ version: 2 }))

    await updateSegment('dub_1', 'seg_a', 'es', { start: 0, end: 1.8, text: 'Buenos días' })

    const [url, init] = lastCall()
    expect(url).toBe('/api/elevenlabs/v1/dubbing/resource/dub_1/segment/seg_a/es')
    expect(init?.method).toBe('PATCH')
    expect(lastBody()).toEqual({ start_time: 0, end_time: 1.8, text: 'Buenos días' })
  })

  it('adds a span the transcription missed, under the speaker that owns them', async () => {
    fetchMock.mockResolvedValue(json({ version: 3, new_segment: 'seg_new' }))

    const id = await createSegment('dub_1', 'sp_1', { start: 4, end: 5, text: 'Adiós' })

    expect(id).toBe('seg_new')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/resource/dub_1/speaker/sp_1/segment')
  })

  it('points the speaker at the clip’s own voice without creating one', async () => {
    // Where the whole clone-and-delete dance went. ElevenLabs copies the voice
    // out of the media it was given, inside its own account, so nothing here
    // makes a voice and nothing has to remember to remove one.
    fetchMock.mockResolvedValue(json({ version: 4 }))

    await setSpeakerVoice('dub_1', 'sp_1', 'clip-clone')

    const [url, init] = lastCall()
    expect(url).toBe('/api/elevenlabs/v1/dubbing/resource/dub_1/speaker/sp_1')
    expect(init?.method).toBe('PATCH')
    expect(lastBody()).toEqual({ voice_id: 'clip-clone' })
  })
})

describe('saying it again', () => {
  it('names every segment to re-say, and the one language to say it in', async () => {
    fetchMock.mockResolvedValue(json({ version: 5 }))

    await dubSegments('dub_1', ['seg_a', 'seg_b'], 'es')

    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/resource/dub_1/dub')
    expect(lastBody()).toEqual({ segments: ['seg_a', 'seg_b'], languages: ['es'] })
  })

  it('renders audio rather than video, because the picture is untouched', async () => {
    fetchMock.mockResolvedValue(json({ version: 6, render_id: 'ren_1' }))

    const renderId = await renderDub('dub_1', 'es')

    expect(renderId).toBe('ren_1')
    expect(lastCall()[0]).toBe('/api/elevenlabs/v1/dubbing/resource/dub_1/render/es')
    expect(lastBody()).toEqual({ render_type: 'mp3', normalize_volume: false })
  })
})

describe('waitForRender', () => {
  it('waits for the named render, and not for any other', async () => {
    const withRenders = (renders: Record<string, { status: string }>) =>
      json({ ...RESOURCE, renders })

    fetchMock
      // An older render for the same job is already complete. Reading the map
      // rather than the id would call this done before it started.
      .mockResolvedValueOnce(withRenders({ ren_0: { status: 'complete' } }))
      .mockResolvedValueOnce(
        withRenders({ ren_0: { status: 'complete' }, ren_1: { status: 'processing' } }),
      )
      .mockResolvedValueOnce(
        withRenders({ ren_0: { status: 'complete' }, ren_1: { status: 'complete' } }),
      )

    await waitForRender('dub_1', 'ren_1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up when the render itself failed', async () => {
    fetchMock.mockResolvedValue(json({ ...RESOURCE, renders: { ren_1: { status: 'failed' } } }))
    await expect(waitForRender('dub_1', 'ren_1')).rejects.toThrow(/could not render/i)
  })
})

describe('alignWords', () => {
  it('sends the rendered track and the script, and returns the words timed', async () => {
    // The one thing dubbing does not hand back. Without this the karaoke
    // highlight has nothing to follow.
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
    const form = lastCall()[1]?.body as FormData
    expect(form.get('text')).toBe('Buenos días')
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
