import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The routing and bookkeeping in `netlify/functions/google.ts`.
 *
 * Lives here rather than beside the handler because Netlify turns every file in
 * the functions directory into a deployable endpoint — see functionNames.test.ts.
 *
 * The exchange itself is covered by tokenVault.test.ts and token verification by
 * auth0.test.ts, so both are mocked out. What is worth pinning down here is what
 * only exists in the handler: which routes demand a token, and the difference
 * between a grant the user has to restore and a deployment nobody has finished
 * setting up.
 */
const auth0User = vi.fn()
const googleAccessToken = vi.fn()

let vaultReady = true
let authReady = true

class FakeTokenVaultError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

class FakeAuth0UnavailableError extends Error {}

vi.mock('./auth0', () => ({
  auth0User: (token: string, config: unknown) => auth0User(token, config) as unknown,
  auth0Config: () =>
    authReady ? { domain: 'tenant.auth0.com', audience: 'https://editor-cat/api' } : null,
  Auth0UnavailableError: FakeAuth0UnavailableError,
}))

vi.mock('./tokenVault', () => ({
  vaultConfig: () =>
    vaultReady
      ? { domain: 'tenant.auth0.com', clientId: 'backend-abc', clientSecret: 'secret-xyz' }
      : null,
  googleAccessToken: (subject: string) => googleAccessToken(subject) as unknown,
  TokenVaultError: FakeTokenVaultError,
}))

const handler = (await import('../functions/google')).default

const GRANT = { accessToken: 'ya29.token', expiresIn: 3599, scope: 'drive.file' }

function get(route: string, token?: string): Request {
  return new Request(`https://site.example/api/google/${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

function post(route: string, token?: string): Request {
  return new Request(`https://site.example/api/google/${route}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vaultReady = true
  authReady = true
  auth0User.mockResolvedValue({ id: 'auth0|42', email: 'someone@example.com' })
  googleAccessToken.mockResolvedValue(GRANT)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('status', () => {
  it('answers without a token, because the gate asks before there is one', async () => {
    const response = await handler(get('status'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      durable: true,
      connected: false,
      detail: expect.stringContaining('no-token'),
    })
    // Nothing about a *user* is disclosed to an anonymous caller — only whether
    // the deployment is set up, which the README states publicly anyway.
    expect(googleAccessToken).not.toHaveBeenCalled()
  })

  it('reports a usable grant for a caller who has one', async () => {
    const response = await handler(get('status', 'auth0-token'))

    await expect(response.json()).resolves.toEqual({ durable: true, connected: true })
  })

  it('reports a withdrawn grant as simply not connected', async () => {
    // Revoking Drive from the Google account page is an ordinary thing to do,
    // and the gate answers it by asking for a fresh sign-in — not an error.
    googleAccessToken.mockRejectedValue(new FakeTokenVaultError(409, 'invalid_grant', 'gone'))

    const response = await handler(get('status', 'auth0-token'))

    expect(response.status).toBe(200)
    // Named, because from the outside it is identical to a token this
    // deployment refused — and the two are fixed in unrelated places.
    await expect(response.json()).resolves.toMatchObject({
      durable: true,
      connected: false,
      detail: expect.stringContaining('no-grant'),
    })
  })

  it('names a token it refused, which is the other way to look unconnected', async () => {
    // Almost always AUTH0_AUDIENCE in the function environment disagreeing with
    // the VITE_ pair the bundle was built with, and nothing whatever to do with
    // Google. Without this the two are one symptom.
    auth0User.mockResolvedValue(null)

    await expect((await handler(get('status', 'auth0-token'))).json()).resolves.toMatchObject({
      durable: true,
      connected: false,
      detail: expect.stringContaining('token-rejected'),
    })
  })

  it('names an unconfigured deployment rather than blaming the visitor', async () => {
    vaultReady = false

    const response = await handler(get('status', 'auth0-token'))

    await expect(response.json()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'not-configured',
    })
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('AUTH0_BACKEND_CLIENT_ID')
  })

  it('keeps a store that is merely down apart from one never set up', async () => {
    // Answered 200, not 502, on purpose. The question asked was whether this
    // deployment can reach Drive, and a 502 collapses the reason back into
    // "something went wrong", which is then all the browser can show.
    googleAccessToken.mockRejectedValue(new FakeTokenVaultError(502, 'unreachable', 'down'))

    const response = await handler(get('status', 'auth0-token'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      durable: true,
      connected: false,
      problem: 'unreachable',
      detail: expect.stringContaining('vault-unreachable'),
    })
  })

  it('does not treat an unverifiable token as a broken deployment', async () => {
    auth0User.mockRejectedValue(new FakeAuth0UnavailableError('jwks down'))

    await expect((await handler(get('status', 'auth0-token'))).json()).resolves.toMatchObject({
      durable: true,
      connected: false,
      detail: expect.stringContaining('verify-unreachable'),
    })
  })
})

describe('token', () => {
  it('hands back the Google token the exchange produced', async () => {
    const response = await handler(post('token', 'auth0-token'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(GRANT)
    // The caller's own Auth0 token is the subject: it is what proves to Auth0
    // whose Google grant is being asked for.
    expect(googleAccessToken).toHaveBeenCalledWith('auth0-token')
  })

  it('never lets a Google token be cached between here and the browser', async () => {
    const response = await handler(post('token', 'auth0-token'))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a request carrying no token', async () => {
    expect((await handler(post('token'))).status).toBe(401)
    expect(googleAccessToken).not.toHaveBeenCalled()
  })

  it('refuses a token Auth0 does not accept', async () => {
    auth0User.mockResolvedValue(null)
    expect((await handler(post('token', 'auth0-token'))).status).toBe(401)
  })

  it('answers 502 rather than 401 when Auth0 could not be asked', async () => {
    // Telling someone to sign in again during an outage is advice that cannot
    // work, and they will take it repeatedly.
    auth0User.mockRejectedValue(new FakeAuth0UnavailableError('jwks down'))
    expect((await handler(post('token', 'auth0-token'))).status).toBe(502)
  })

  it('reports a withdrawn grant as the user’s to fix, not an outage', async () => {
    googleAccessToken.mockRejectedValue(new FakeTokenVaultError(409, 'invalid_grant', 'gone'))

    const response = await handler(post('token', 'auth0-token'))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Sign in/),
    })
  })

  it('refuses the wrong method, so a stray GET cannot look like a token request', async () => {
    expect((await handler(get('token', 'auth0-token'))).status).toBe(405)
  })

  it('refuses every route that is not one of the two', async () => {
    expect((await handler(post('connect', 'auth0-token'))).status).toBe(404)
    expect((await handler(post('disconnect', 'auth0-token'))).status).toBe(404)
  })

  it('says the site is not set up rather than failing the exchange', async () => {
    authReady = false
    expect((await handler(post('token', 'auth0-token'))).status).toBe(503)
  })
})
