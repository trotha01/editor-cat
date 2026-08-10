import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseAccessToken = vi.fn<() => Promise<string | null>>(
  async () => 'supabase-session-token',
)

vi.mock('../supabase/session', () => ({
  supabaseAccessToken: () => supabaseAccessToken(),
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
  supabaseAccessToken.mockResolvedValue('supabase-session-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('connectionStatus', () => {
  it('reports what the site supports and whether this account is connected', async () => {
    const calls = serve(200, { durable: true, connected: true })

    await expect(connectionStatus()).resolves.toEqual({ durable: true, connected: true })
    expect(calls[0]?.url).toBe('/api/google/status')
  })

  it('sends the session token, since the connection is filed under the account', async () => {
    const calls = serve(200, { durable: true, connected: false })

    await connectionStatus()

    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer supabase-session-token' })
  })

  it('passes on the reason the site gave for not storing connections', async () => {
    // The gate can only tell someone what to fix if this carries the answer up.
    // Collapsing every "no" into one made the screen name environment variables
    // that were already set while the real gap — an unrun migration — went
    // unmentioned, which is a bug that costs whoever deployed it an afternoon.
    serve(200, { durable: false, connected: false, problem: 'no-table' })

    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'no-table',
    })
  })

  it('reads an unlabelled refusal as "not configured", which is what it meant', async () => {
    // A cached bundle can outlive the function it talks to. Before the function
    // named reasons, `durable: false` had exactly one.
    serve(200, { durable: false, connected: false })

    await expect(connectionStatus()).resolves.toMatchObject({ problem: 'not-configured' })
  })

  it('refuses a reason it does not recognise rather than passing it to the UI', async () => {
    serve(200, { durable: false, connected: false, problem: 'something-invented-later' })

    await expect(connectionStatus()).resolves.toMatchObject({ problem: 'not-configured' })
  })

  it('treats a missing endpoint as unreachable, not as a verdict on the setup', async () => {
    // Plain `vite dev` serves no /api routes at all, and an older deploy has no
    // such function. Neither is evidence about how the site is configured, so
    // neither may claim it is configured wrongly.
    serve(404, { error: 'Not found' })

    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'unreachable',
    })
  })

  it('treats being offline the same way, rather than failing the whole load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(connectionStatus()).resolves.toMatchObject({
      durable: false,
      problem: 'unreachable',
    })
  })

  it('is not fooled by a static host answering /api with the app itself', async () => {
    // An SPA fallback returns index.html and a cheerful 200. Trusting that would
    // read as "this site stores connections" and send the user through a consent
    // flow that cannot possibly complete.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><title>editor-cat</title>', { status: 200 })),
    )

    await expect(connectionStatus()).resolves.toMatchObject({
      durable: false,
      problem: 'unreachable',
    })
  })

  it('bounds the wait, so a hung request cannot strand the sign-in screen', async () => {
    // The gate waits on this before it can draw a button: a request that never
    // settles would leave no way into the app at all. Whatever the abort ends up
    // throwing lands in the same catch as being offline, above.
    const calls = serve(200, { durable: true, connected: false })

    await connectionStatus()

    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
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
    supabaseAccessToken.mockResolvedValue(null)
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
