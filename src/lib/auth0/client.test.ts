import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Adopting a session, which is the half of sign-in that has to survive a reload.
 *
 * `getUser` in auth0-spa-js only reads the token cache — it never refreshes. The
 * cached entry expires in hours, governed by the API's token lifetime, while the
 * rotating refresh token behind it lasts weeks. So a reload past that first
 * boundary looks exactly like a signed-out visitor unless something warms the
 * cache first, and the symptom is a sign-in screen shown to someone who never
 * signed out. That is what these pin down.
 */
const getUser = vi.fn()
const getTokenSilently = vi.fn()
const handleRedirectCallback = vi.fn()
const loginWithRedirect = vi.fn()
const logout = vi.fn()

vi.mock('@auth0/auth0-spa-js', () => ({
  Auth0Client: class {
    getUser = getUser
    getTokenSilently = getTokenSilently
    handleRedirectCallback = handleRedirectCallback
    loginWithRedirect = loginWithRedirect
    logout = logout
  },
}))

const USER = { sub: 'auth0|42', email: 'someone@example.com' }
const ACCOUNT = { id: 'auth0|42', email: 'someone@example.com' }

let client: typeof import('./client')

const original = window.location.href

beforeEach(async () => {
  vi.stubEnv('VITE_AUTH0_DOMAIN', 'tenant.auth0.com')
  vi.stubEnv('VITE_AUTH0_CLIENT_ID', 'spa-abc')
  vi.stubEnv('VITE_AUTH0_AUDIENCE', 'https://editor-cat/api')

  getUser.mockResolvedValue(USER)
  getTokenSilently.mockResolvedValue('auth0-token')
  handleRedirectCallback.mockResolvedValue(undefined)

  vi.resetModules()
  client = await import('./client')
  client.resetForTests()
})

afterEach(() => {
  window.history.replaceState({}, '', original)
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('adoptRedirect', () => {
  it('restores a stored session on an ordinary load', async () => {
    await expect(client.adoptRedirect()).resolves.toEqual(ACCOUNT)
    expect(handleRedirectCallback).not.toHaveBeenCalled()
  })

  it('warms the cache before reading the user, so a reload survives expiry', async () => {
    // The bug this exists for: `getUser` alone answers undefined once the cached
    // token has aged out, and the refresh token that would have renewed it is
    // never consulted.
    await client.adoptRedirect()

    expect(getTokenSilently).toHaveBeenCalled()
    expect(getTokenSilently.mock.invocationCallOrder[0]).toBeLessThan(
      getUser.mock.invocationCallOrder[0]!,
    )
  })

  it('reports nobody signed in when the refresh token has genuinely run out', async () => {
    // Distinct from the case above: here the renewal was attempted and refused,
    // which is a real sign-out rather than a cold cache.
    getTokenSilently.mockRejectedValue(new Error('login_required'))
    getUser.mockResolvedValue(undefined)

    await expect(client.adoptRedirect()).resolves.toBeNull()
  })

  it('completes a sign-in Auth0 redirected back to, and cleans the address bar', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz')

    await expect(client.adoptRedirect()).resolves.toEqual(ACCOUNT)

    expect(handleRedirectCallback).toHaveBeenCalledOnce()
    // `code` is spent, and a reload that replayed it would fail in a way that
    // reads as a broken sign-in rather than a stale URL.
    expect(window.location.search).toBe('')
  })

  it('clears the address bar even when the callback throws', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz')
    handleRedirectCallback.mockRejectedValue(new Error('invalid state'))

    await expect(client.adoptRedirect()).rejects.toThrow(/invalid state/)
    expect(window.location.search).toBe('')
  })

  it('surfaces a refusal from Google without calling the callback at all', async () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_description=Denied&state=xyz')

    await expect(client.adoptRedirect()).rejects.toThrow(/Denied/)
    expect(handleRedirectCallback).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })

  it('reads the address bar once, however many times StrictMode mounts', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz')

    const [a, b] = await Promise.all([client.adoptRedirect(), client.adoptRedirect()])

    expect(a).toEqual(ACCOUNT)
    expect(b).toEqual(ACCOUNT)
    expect(handleRedirectCallback).toHaveBeenCalledOnce()
  })

  it('does nothing at all on a build with no Auth0 settings', async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    const fresh = await import('./client')
    fresh.resetForTests()

    await expect(fresh.adoptRedirect()).resolves.toBeNull()
    expect(getTokenSilently).not.toHaveBeenCalled()
  })
})

describe('beginGoogleSignIn', () => {
  it('asks Google for Drive in the same breath as the account', async () => {
    // What makes this one screen rather than two, and the whole reason the app
    // is on Auth0 rather than Netlify Identity.
    await client.beginGoogleSignIn()

    expect(loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: {
        connection: 'google-oauth2',
        connection_scope: 'https://www.googleapis.com/auth/drive.file',
        redirect_uri: window.location.origin,
      },
    })
  })

  it('never sends `prompt`, which Auth0 answers itself', async () => {
    // Asked for here, `prompt=consent` does not reach Google at all: it is a
    // standard OIDC parameter, so Auth0 puts up its own "Authorize App" screen
    // and forwards nothing. Forcing a fresh Google grant is the connection's
    // `upstream_params`, not this request's business. `access_type` is worse
    // still — `/authorize` rejects it outright.
    await client.beginGoogleSignIn()

    const params = loginWithRedirect.mock.calls[0]?.[0]?.authorizationParams as Record<
      string,
      unknown
    >
    expect(params.prompt).toBeUndefined()
    expect(params.access_type).toBeUndefined()
  })
})

describe('auth0Token', () => {
  it('answers null rather than minting when nobody is signed in', async () => {
    await expect(client.auth0Token()).resolves.toBeNull()
    expect(getTokenSilently).not.toHaveBeenCalled()
  })

  it('mints once there is an account behind the page', async () => {
    await client.adoptRedirect()
    getTokenSilently.mockClear()

    await expect(client.auth0Token()).resolves.toBe('auth0-token')
  })
})
