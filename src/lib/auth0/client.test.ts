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
const getIdTokenClaims = vi.fn()
const handleRedirectCallback = vi.fn()
const loginWithRedirect = vi.fn()
const connectAccountWithRedirect = vi.fn()
const logout = vi.fn()

vi.mock('@auth0/auth0-spa-js', () => ({
  Auth0Client: class {
    getUser = getUser
    getTokenSilently = getTokenSilently
    getIdTokenClaims = getIdTokenClaims
    handleRedirectCallback = handleRedirectCallback
    loginWithRedirect = loginWithRedirect
    connectAccountWithRedirect = connectAccountWithRedirect
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
  getIdTokenClaims.mockResolvedValue({ __raw: 'raw-id-token', sub: USER.sub })
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
  it('asks for the account and nothing else', async () => {
    // Deliberately not `connection_scope`. A login files Google's tokens against
    // the user's *identity*, and Token Vault reads `connected_accounts` — so a
    // Drive scope asked for here is approved into a store the exchange cannot
    // read, and costs a consent screen to do it. `connectDrive` is what stocks
    // the vault.
    await client.beginGoogleSignIn()

    expect(loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: {
        connection: 'google-oauth2',
        redirect_uri: window.location.origin,
      },
    })
  })

  it('never asks for a Drive scope on the login', async () => {
    await client.beginGoogleSignIn()

    const params = loginWithRedirect.mock.calls[0]?.[0]?.authorizationParams as Record<
      string,
      unknown
    >
    expect(params.connection_scope).toBeUndefined()
    expect(JSON.stringify(params)).not.toContain('drive')
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

describe('connectDrive', () => {
  it('asks the My Account API for the Drive scope, on the SDK’s own spelling', async () => {
    // `redirectUri` camel and top-level, `authorization_params` snake, and
    // `login_hint` snake inside it — the connect flow's option names differ from
    // `loginWithRedirect`'s, and getting one wrong fails silently as a consent
    // screen that asks which account again.
    await client.connectDrive('someone@example.com')

    expect(connectAccountWithRedirect).toHaveBeenCalledWith({
      connection: 'google-oauth2',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      redirectUri: window.location.origin,
      authorization_params: { login_hint: 'someone@example.com' },
    })
  })

  it('omits the hint rather than sending an empty one when the address is unknown', async () => {
    // `login_hint: ''` is not the same as no hint: Google reads it as an account
    // to preselect and finds none.
    await client.connectDrive()

    const options = connectAccountWithRedirect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.authorization_params).toBeUndefined()
    expect(options.scopes).toEqual(['https://www.googleapis.com/auth/drive.file'])
  })
})

describe('adoptRedirect on a finished Drive grant', () => {
  it('recognises `connect_code` and hands it to the same callback', async () => {
    // The connect flow comes back with `connect_code` rather than `code`. The
    // SDK sorts the two out by the transaction it stored, so this only has to
    // recognise it — but a callback that did not would leave the grant
    // uncollected and the address bar carrying a spent code.
    window.history.replaceState({}, '', '/?connect_code=abc&state=xyz')

    await expect(client.adoptRedirect()).resolves.toEqual(ACCOUNT)

    expect(handleRedirectCallback).toHaveBeenCalledOnce()
    expect(window.location.search).toBe('')
  })
})

describe('auth0Token', () => {
  it('answers null rather than asking when nobody is signed in', async () => {
    await expect(client.auth0Token()).resolves.toBeNull()
    expect(getTokenSilently).not.toHaveBeenCalled()
  })

  it('answers once there is an account behind the page', async () => {
    await client.adoptRedirect()
    getTokenSilently.mockClear()

    await expect(client.auth0Token()).resolves.toBe('auth0-token')
  })
})

/**
 * The token Supabase takes, which is not the one everything else takes.
 *
 * Two tokens, one session, and they are not interchangeable: PostgREST switches
 * roles on an unnamespaced `role` claim, and Auth0 will only carry that on the
 * ID token — it strips unnamespaced custom claims from access tokens. Handing
 * over the wrong one does not fail loudly. It verifies, reads as `anon`, and
 * returns an empty project list.
 */
describe('auth0IdToken', () => {
  it('answers null rather than asking when nobody is signed in', async () => {
    await expect(client.auth0IdToken()).resolves.toBeNull()
    expect(getIdTokenClaims).not.toHaveBeenCalled()
  })

  it('hands back the raw ID token rather than its decoded claims', async () => {
    // PostgREST verifies a signature over the encoded form; the parsed claims
    // are not a credential.
    await client.adoptRedirect()

    await expect(client.auth0IdToken()).resolves.toBe('raw-id-token')
  })

  it('refreshes before reading, because the claims come from a cache', async () => {
    // `getIdTokenClaims` is a synchronous cache read dressed as a promise. Auth0
    // returns a fresh id_token alongside every refreshed access token, so the
    // refresh is what puts a current one there — without it a long-open tab goes
    // on presenting an expired credential to PostgREST.
    await client.adoptRedirect()
    getTokenSilently.mockClear()

    await client.auth0IdToken()

    expect(getTokenSilently).toHaveBeenCalled()
  })

  it('lets a refused refresh through, which is how an ended session reports itself', async () => {
    // The caller turns this into "sign in again"; swallowing it here would hand
    // supabase-js a stale token and turn a lapsed session into a query failure.
    await client.adoptRedirect()
    getTokenSilently.mockRejectedValue(new Error('login_required'))

    await expect(client.auth0IdToken()).rejects.toThrow(/login_required/)
  })
})
