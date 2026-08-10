import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenVaultError, googleAccessToken, vaultConfig } from './tokenVault'

/**
 * The exchange that replaced this app's own Google OAuth machinery.
 *
 * What is worth pinning down is the request shape — Auth0 rejects a token
 * exchange that names the wrong grant or token types, and the failure reads as a
 * generic 403 that says nothing about which of the six parameters was wrong —
 * and the one distinction the caller acts on: a grant the user has to restore
 * versus an outage nobody can sign their way out of.
 */

const CONFIG = {
  domain: 'tenant.auth0.com',
  clientId: 'backend-abc',
  clientSecret: 'secret-xyz',
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ENV_KEYS = [
  'AUTH0_DOMAIN',
  'VITE_AUTH0_DOMAIN',
  'AUTH0_BACKEND_CLIENT_ID',
  'AUTH0_BACKEND_CLIENT_SECRET',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  // Vitest reuses worker processes, so environment changes have to be undone or
  // they leak into whatever file runs next.
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('vaultConfig', () => {
  it('needs a machine client of its own, not the browser’s', () => {
    process.env.AUTH0_DOMAIN = 'tenant.auth0.com'
    process.env.AUTH0_BACKEND_CLIENT_ID = 'backend-abc'
    expect(vaultConfig()).toBeNull()

    process.env.AUTH0_BACKEND_CLIENT_SECRET = 'secret-xyz'
    expect(vaultConfig()).toEqual(CONFIG)
  })

  it('takes the tenant from the build-time variable, which is the same tenant', () => {
    // Asking an operator to set one string twice is how the two drift apart.
    process.env.VITE_AUTH0_DOMAIN = 'https://tenant.auth0.com/'
    process.env.AUTH0_BACKEND_CLIENT_ID = 'backend-abc'
    process.env.AUTH0_BACKEND_CLIENT_SECRET = 'secret-xyz'

    expect(vaultConfig()).toEqual(CONFIG)
  })

  it('has no VITE_ fallback for the secret, by design', () => {
    process.env.AUTH0_DOMAIN = 'tenant.auth0.com'
    process.env.AUTH0_BACKEND_CLIENT_ID = 'backend-abc'
    process.env.VITE_AUTH0_BACKEND_CLIENT_SECRET = 'leaked'

    expect(vaultConfig()).toBeNull()
  })
})

describe('googleAccessToken', () => {
  it('asks Auth0 for a federated token, in the shape it insists on', async () => {
    // Pinned exactly, because the one time this was wrong Auth0 answered by
    // naming two parameters that were right and not the one that was not.
    const fetchImpl = vi.fn().mockResolvedValue(answer({ access_token: 'ya29.token' }))

    await googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://tenant.auth0.com/oauth/token')
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type:
        'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: 'auth0-token',
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      connection: 'google-oauth2',
      client_id: 'backend-abc',
      client_secret: 'secret-xyz',
    })
  })

  it('returns the Google grant, with an hour assumed when none is stated', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(answer({ access_token: 'ya29.token', scope: 'drive.file' }))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ accessToken: 'ya29.token', expiresIn: 3600, scope: 'drive.file' })
  })

  it('reports a withdrawn grant as the user’s to fix rather than an outage', async () => {
    // 409 sends the gate to "sign in again", which is the only cure. A 502 would
    // send it to "reload", which never works.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(answer({ error: 'invalid_grant', error_description: 'no grant' }, 403))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_grant' })
  })

  it('reports anything else as ours or Auth0’s to fix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer({ error: 'invalid_client' }, 401))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502, code: 'invalid_client' })
  })

  it('lets the status speak when the body is not JSON at all', async () => {
    // An outage page rather than an error response, which is what a proxy in
    // front of Auth0 answers with.
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(TokenVaultError)
  })

  it('treats a 200 with no token as a failure, not a grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer({ token_type: 'bearer' }))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' })
  })

  it('turns a network failure into a 502 rather than letting it escape raw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))

    await expect(
      googleAccessToken('auth0-token', CONFIG, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502, code: 'unreachable' })
  })
})
