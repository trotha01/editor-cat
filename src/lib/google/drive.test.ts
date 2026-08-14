import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError, downloadFile } from './drive'

/**
 * Reading a file back out of Drive.
 *
 * All this module has to do is fetch bytes by id, and the interesting part is
 * not the happy path — it is what happens when a long migration meets a token
 * that has stopped working, or a Drive that says "too fast". Both are ordinary
 * during a run of hundreds of files, and both look like a failed migration if
 * they are not handled.
 */
vi.mock('./gis', () => ({
  accessToken: () => Promise.resolve(tokens.shift() ?? 'ya29.token'),
  invalidateToken: () => invalidated(),
}))

let tokens: string[] = []
const invalidated = vi.fn()

function bytes(body = 'video-bytes'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })
}

function refusal(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  tokens = []
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // Backoff jitters, so the delays are real time. Faked, or the rate-limit
  // test waits several seconds for no benefit.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('downloading a file', () => {
  it('asks for the bytes rather than the metadata', async () => {
    fetchMock.mockResolvedValue(bytes())

    await downloadFile('1a2b3c')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // `alt=media` is the whole difference between the file and a JSON
    // description of it, and getting it wrong yields a valid-looking Blob of
    // JSON that only fails much later, when something tries to play it.
    expect(url).toContain('alt=media')
    expect(url).toContain('/files/1a2b3c')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token')
  })

  it('reaches files on shared drives, not just My Drive', async () => {
    fetchMock.mockResolvedValue(bytes())

    await downloadFile('1a2b3c')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('supportsAllDrives=true')
  })

  it('escapes an id rather than pasting it into the path', async () => {
    fetchMock.mockResolvedValue(bytes())

    await downloadFile('a/b?c')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/files/a%2Fb%3Fc')
  })
})

describe('a token that has stopped working', () => {
  it('mints a new one and tries again, which is what survives a long migration', async () => {
    // An hour into moving a few hundred files is exactly when the token minted
    // at the start stops being accepted. Without this the run dies partway and
    // the user is left to work out why.
    tokens = ['stale', 'fresh']
    fetchMock.mockResolvedValueOnce(refusal(401)).mockResolvedValueOnce(bytes())

    const blob = await downloadFile('1a2b3c')

    expect(invalidated).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, second] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer fresh')
    expect(blob.type).toBe('video/mp4')
  })

  it('gives up on the second 401, rather than looping', async () => {
    // A freshly minted token that is also refused is not a staleness problem,
    // and retrying it forever is how a migration hangs instead of reporting.
    fetchMock.mockResolvedValue(refusal(401))

    await expect(downloadFile('1a2b3c')).rejects.toThrow(/session expired/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('a Drive that says "too fast"', () => {
  it('backs off and retries a 429', async () => {
    fetchMock.mockResolvedValueOnce(refusal(429)).mockResolvedValueOnce(bytes())

    const pending = downloadFile('1a2b3c')
    await vi.advanceTimersByTimeAsync(5000)
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('also retries the 403 that means throttled rather than forbidden', async () => {
    // Drive signals rate limiting both ways, and treating this 403 as a refusal
    // fails a file that would have succeeded a second later.
    fetchMock
      .mockResolvedValueOnce(
        refusal(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
      )
      .mockResolvedValueOnce(bytes())

    const pending = downloadFile('1a2b3c')
    await vi.advanceTimersByTimeAsync(5000)
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 403 that really is a refusal', async () => {
    fetchMock.mockResolvedValue(refusal(403, { error: { message: 'Insufficient permission' } }))

    // Awaited directly rather than advanced through: this path sets no timer,
    // so there is nothing to wait out, and holding the promise across a timer
    // advance would only leave the rejection unhandled for a tick.
    await expect(downloadFile('1a2b3c')).rejects.toThrow(/refused/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a file that is not there', () => {
  it('says so as a 404, which is the one failure a later run cannot fix', async () => {
    fetchMock.mockResolvedValue(refusal(404))

    const error = await downloadFile('gone').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DriveError)
    expect((error as DriveError).status).toBe(404)
  })
})
