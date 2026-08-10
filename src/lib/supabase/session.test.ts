import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Holding the Supabase session that an Auth0 sign-in buys.
 *
 * Every Supabase query calls into here, and the editor saves, syncs assets and
 * uploads at once — so the caching is not a nicety. Without it a single expiry
 * fans out into a burst of identical mints, and supabase-js is explicit that it
 * may call the hook concurrently and often.
 */
const auth0Token = vi.fn<() => Promise<string | null>>()
const currentAccount = vi.fn<() => object | null>()

vi.mock('../auth0/client', () => ({
  auth0Token: () => auth0Token(),
  currentAccount: () => currentAccount(),
}))

const {
  clearSupabaseSession,
  SessionNotConfiguredError,
  sessionReadiness,
  SignInRequiredError,
  supabaseAccessToken,
} = await import('./session')

let minted = 0

/** Answers `/api/session` with a fresh token each time, and counts the mints. */
function serveMints(lifetimeSeconds = 3600) {
  minted = 0
  vi.stubGlobal('fetch', () => {
    minted += 1
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: `minted-token-${minted}`, expires_in: lifetimeSeconds }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
  })
}

function serve(status: number, body: unknown = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  return calls
}

beforeEach(() => {
  clearSupabaseSession()
  auth0Token.mockResolvedValue('auth0-token')
  currentAccount.mockReturnValue({ id: 'auth0|42', email: 'someone@example.com' })
  serveMints()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('supabaseAccessToken', () => {
  it('trades the Auth0 token for a Supabase one', async () => {
    const calls = serve(200, { access_token: 'minted-token', expires_in: 3600 })

    await expect(supabaseAccessToken()).resolves.toBe('minted-token')

    expect(calls[0]?.url).toBe('/api/session')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer auth0-token' })
  })

  it('holds the session rather than minting one per query', async () => {
    await supabaseAccessToken()
    await supabaseAccessToken()
    await supabaseAccessToken()

    expect(minted).toBe(1)
  })

  it('shares one mint between callers that arrive together', async () => {
    // A generation finishing kicks off a project save, a catalogue write and an
    // upload in the same tick. Without a shared attempt that is three mints.
    const [a, b, c] = await Promise.all([
      supabaseAccessToken(),
      supabaseAccessToken(),
      supabaseAccessToken(),
    ])

    expect(minted).toBe(1)
    expect([a, b, c]).toEqual(['minted-token-1', 'minted-token-1', 'minted-token-1'])
  })

  it('renews a session that is about to expire, rather than one that just has', async () => {
    // A token that expires mid-save fails the save. The margin is what makes a
    // long upload survive the boundary.
    serveMints(30)

    await expect(supabaseAccessToken()).resolves.toBe('minted-token-1')
    await expect(supabaseAccessToken()).resolves.toBe('minted-token-2')
  })

  it('answers null when nobody is signed in, which is not an error', async () => {
    currentAccount.mockReturnValue(null)

    await expect(supabaseAccessToken()).resolves.toBeNull()
    expect(minted).toBe(0)
  })

  it('asks for a sign-in when the Auth0 session has run out', async () => {
    // auth0-spa-js throws when a silent refresh is refused, so a throw
    // from here is what an expired refresh token looks like.
    auth0Token.mockRejectedValue(new Error('failed to refresh'))

    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SignInRequiredError)
  })

  it('asks for a sign-in when the function refuses the Auth0 token', async () => {
    serve(401, { error: 'Sign in to continue.' })

    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SignInRequiredError)
  })

  it('keeps a site that cannot mint apart from a session that has lapsed', async () => {
    // Both leave the user signed out, but only one is worth telling them to
    // sign in again about.
    serve(503, { error: 'This site is not set up for sign-in.' })

    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SessionNotConfiguredError)
  })

  it('treats the SPA fallback as a site with no such endpoint', async () => {
    // A static host answers /api/* with index.html and a cheerful 200. Parsing
    // that throws a SyntaxError, which would reach the user as gibberish.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<!doctype html><title>editor-cat</title>', { status: 200 })),
    )

    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SessionNotConfiguredError)
  })

  it('does not hold on to a failed mint', async () => {
    serve(401)
    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SignInRequiredError)

    // Otherwise one refused mint poisons every later call for the life of the
    // page, and signing in again would change nothing.
    serve(200, { access_token: 'minted-after-retry', expires_in: 3600 })
    await expect(supabaseAccessToken()).resolves.toBe('minted-after-retry')
  })
})

describe('clearSupabaseSession', () => {
  it('drops the held session, so the next caller mints a fresh one', async () => {
    await supabaseAccessToken()
    clearSupabaseSession()
    await supabaseAccessToken()

    expect(minted).toBe(2)
  })
})

describe('sessionReadiness', () => {
  it('reports a site that can mint sessions', async () => {
    const calls = serve(200, { ready: true })

    await expect(sessionReadiness()).resolves.toEqual({ ready: true })
    // Asked without a token: the sign-in screen wants to know before there is
    // an account, which is the whole point of a separate GET.
    expect(calls[0]?.init?.headers).toBeUndefined()
  })

  it('passes on the reason a site cannot', async () => {
    serve(200, { ready: false, problem: 'not-configured' })

    await expect(sessionReadiness()).resolves.toEqual({
      ready: false,
      problem: 'not-configured',
    })
  })

  it('calls every way of not getting an answer unreachable', async () => {
    // None of them is evidence about how the site is configured, so none of
    // them may claim it is configured wrongly.
    serve(500)
    await expect(sessionReadiness()).resolves.toEqual({ ready: false, problem: 'unreachable' })

    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    await expect(sessionReadiness()).resolves.toEqual({ ready: false, problem: 'unreachable' })
  })
})
