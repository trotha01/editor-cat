import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kindForMime, moveFile } from './drive'

vi.mock('./gis', () => ({
  accessToken: () => Promise.resolve('ya29.token'),
  invalidateToken: () => {},
}))

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('kindForMime', () => {
  it('maps the media types the editor can use', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/webm;codecs=opus')).toBe('audio')
  })

  it('rejects anything else, so Docs and folders never reach the library', () => {
    // The Picker can be pointed at a folder view, and a stray Doc in a media
    // folder should be ignored rather than downloaded as a video.
    expect(kindForMime('application/vnd.google-apps.document')).toBeNull()
    expect(kindForMime('application/vnd.google-apps.folder')).toBeNull()
    expect(kindForMime('application/pdf')).toBeNull()
  })
})

/**
 * A move is a read and a write, because Drive has no move — a file's folders are
 * its `parents`, and there is no way to say "and none of the others". Both
 * halves are asserted from the URL, which is where every part of this call lives.
 */
describe('moveFile', () => {
  it('adds the new folder and takes away the ones it was in', async () => {
    fetchMock.mockResolvedValueOnce(answer({ parents: ['camera_uploads'] }))
    fetchMock.mockResolvedValueOnce(answer({}))

    await moveFile('file_take', 'folder_cervelle')

    const [url, init] = fetchMock.mock.calls[1] ?? []
    expect(url).toContain('addParents=folder_cervelle')
    expect(url).toContain('removeParents=camera_uploads')
    expect((init as RequestInit).method).toBe('PATCH')
  })

  it('leaves a file that is already in the folder alone', async () => {
    // The common case: a take picked out of the word's own folder, which is
    // where the Picker opens. Patching it to where it already is would be a
    // write to somebody's Drive for nothing.
    fetchMock.mockResolvedValueOnce(answer({ parents: ['folder_cervelle'] }))

    await moveFile('file_take', 'folder_cervelle')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('adds the folder without a removal when the file had no parents', async () => {
    // `removeParents=` empty would be Drive's own error rather than ours.
    fetchMock.mockResolvedValueOnce(answer({}))
    fetchMock.mockResolvedValueOnce(answer({}))

    await moveFile('file_take', 'folder_cervelle')

    const [url] = fetchMock.mock.calls[1] ?? []
    expect(url).toContain('addParents=folder_cervelle')
    expect(url).not.toContain('removeParents')
  })
})
