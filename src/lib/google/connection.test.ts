import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const currentAccessToken = vi.fn<() => string | null>(() => 'supabase-session-token')

vi.mock('../../state/useAuthStore', () => ({
  currentAccessToken: () => currentAccessToken(),
}))

const {
  clearConnection,
  connectionStatus,
  ConnectionExpiredError,
  NoConnectionError,
  NotDurableError,
  requestAccessToken,
  saveConnection,
  SessionRequiredError,
} = await import('./connection')

/** Answers every call with one canned response, and records the requests. */
function serve(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

beforeEach(() => {
  currentAccessToken.mockReturnValue('supabase-session-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('connectionStatus', () => {
  it('reports what the site supports and whether this account is connected', async () => {
    const calls = serve(200, { durable: true, connected: true, scope: 'drive.file' })

    await expect(connectionStatus()).resolves.toEqual({
      durable: true,
      connected: true,
      scope: 'drive.file',
    })
    expect(calls[0]?.url).toBe('/api/google/status')
  })

  it('sends the session token, since the connection is filed under the account', async () => {
    const calls = serve(200, { durable: true, connected: false, scope: '' })

    await connectionStatus()

    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer supabase-session-token' })
  })

  it('treats a missing endpoint as "no stored connections here"', async () => {
    // Plain `vite dev` serves no /api routes at all, and an older deploy has no
    // such function. Neither is an error worth showing anyone — the app has a
    // fallback and only needs to know which world it is in.
    serve(404, { error: 'Not found' })

    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      scope: '',
    })
  })

  it('treats being offline the same way, rather than failing the whole load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      scope: '',
    })
  })
})

describe('saveConnection', () => {
  it('posts the code and returns the access token it was traded for', async () => {
    const calls = serve(200, {
      access_token: 'ya29.token',
      expires_in: 3599,
      scope: 'drive.file',
      durable: true,
    })

    const grant = await saveConnection('one-time-code')

    expect(calls[0]?.url).toBe('/api/google/connect')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'one-time-code' })
    expect(grant).toEqual({
      accessToken: 'ya29.token',
      expiresIn: 3599,
      scope: 'drive.file',
      durable: true,
    })
  })

  it('passes on that a connection will not survive the hour', async () => {
    serve(200, { access_token: 'ya29.token', expires_in: 3599, scope: '', durable: false })

    expect((await saveConnection('code')).durable).toBe(false)
  })

  it('reports a site that cannot store connections distinctly, so the caller can fall back', async () => {
    serve(503, { error: 'This site does not keep Drive connected.' })

    await expect(saveConnection('code')).rejects.toBeInstanceOf(NotDurableError)
  })

  it('surfaces the server’s own wording for anything else', async () => {
    serve(502, { error: 'Google refused the request.' })

    await expect(saveConnection('code')).rejects.toThrow('Google refused the request.')
  })
})

describe('requestAccessToken', () => {
  it('mints a token from the stored connection', async () => {
    const calls = serve(200, { access_token: 'ya29.fresh', expires_in: 3599, scope: 'drive.file' })

    await expect(requestAccessToken()).resolves.toEqual({
      accessToken: 'ya29.fresh',
      expiresIn: 3599,
      scope: 'drive.file',
    })
    expect(calls[0]?.url).toBe('/api/google/token')
  })

  it('distinguishes "never connected" from "connection broke"', async () => {
    // The first is the ordinary state of a new user and must not look like a
    // failure; the second is the only one worth interrupting anyone about.
    serve(404, { error: 'No Google Drive connection is saved for this account.' })
    await expect(requestAccessToken()).rejects.toBeInstanceOf(NoConnectionError)

    serve(409, { error: 'Your Google connection expired.' })
    await expect(requestAccessToken()).rejects.toBeInstanceOf(ConnectionExpiredError)
  })

  it('keeps a refused session apart from a site that stores nothing', async () => {
    // A laptop waking from sleep presents a token that expired while it slept.
    // Reading that as "this site cannot store connections" would abandon the
    // stored connection for the rest of the session over a passing hiccup.
    currentAccessToken.mockReturnValue(null)
    serve(401, { error: 'Sign in to generate.' })
    await expect(requestAccessToken()).rejects.toBeInstanceOf(SessionRequiredError)

    serve(503, { error: 'This site does not keep Drive connected.' })
    await expect(requestAccessToken()).rejects.toBeInstanceOf(NotDurableError)
  })
})

describe('clearConnection', () => {
  it('accepts a site with nothing stored as already disconnected', async () => {
    serve(503, { error: 'This site does not keep Drive connected.' })
    await expect(clearConnection()).resolves.toBeUndefined()

    serve(404, { error: 'Unknown Google endpoint.' })
    await expect(clearConnection()).resolves.toBeUndefined()
  })

  it('raises anything that means the connection is still live', async () => {
    serve(502, { error: 'Could not disconnect Google Drive.' })

    await expect(clearConnection()).rejects.toThrow('Could not disconnect Google Drive.')
  })
})
