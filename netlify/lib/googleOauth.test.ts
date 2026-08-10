import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CALLBACK_PATH,
  exchangeCode,
  GoogleOauthError,
  oauthConfig,
  redirectUri,
  refreshAccessToken,
  revokeToken,
} from './googleOauth'
import { CALLBACK_PATH as BROWSER_CALLBACK_PATH } from '../../src/lib/google/callbackPath'

describe('the callback path', () => {
  it('is the same string the browser sends, which Google compares byte for byte', () => {
    // Declared twice because the browser and the functions are separate
    // TypeScript projects, so nothing else can notice them drifting apart. When
    // they do, the authorisation request and the code exchange name different
    // redirect URIs and Google answers `redirect_uri_mismatch` — a runtime
    // failure that points at neither file.
    expect(CALLBACK_PATH).toBe(BROWSER_CALLBACK_PATH)
  })
})

const config = { clientId: 'client-abc.apps.googleusercontent.com', clientSecret: 'secret-xyz' }

/** Builds a stub `fetch` that gives the same answer every time, recording each request. */
function respondWith(body: unknown, status = 200) {
  const calls: { url: string; params: URLSearchParams }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), params: new URLSearchParams(String(init?.body ?? '')) })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const grantBody = {
  access_token: 'ya29.token',
  expires_in: 3599,
  scope: 'https://www.googleapis.com/auth/drive.file',
  refresh_token: '1//refresh',
}

describe('oauthConfig', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.VITE_GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('is unavailable without a client secret, whatever else is set', () => {
    process.env.GOOGLE_CLIENT_ID = 'client-abc'
    expect(oauthConfig()).toBeNull()
  })

  it('falls back to the build-time client ID, since it is the same OAuth client', () => {
    process.env.VITE_GOOGLE_CLIENT_ID = 'client-abc'
    process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz'

    // Asking an operator to set one string under two names is how the two end
    // up disagreeing, which fails as an opaque redirect_uri_mismatch.
    expect(oauthConfig()).toEqual({ clientId: 'client-abc', clientSecret: 'secret-xyz' })
  })

  it('prefers the unprefixed name when both are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'server-id'
    process.env.VITE_GOOGLE_CLIENT_ID = 'bundle-id'
    process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz'

    expect(oauthConfig()?.clientId).toBe('server-id')
  })
})

describe('redirectUri', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('is derived from the request, so no caller-supplied value has to be trusted', () => {
    delete process.env.GOOGLE_REDIRECT_URI
    expect(redirectUri('https://editor.example.com/api/google/connect')).toBe(
      `https://editor.example.com${CALLBACK_PATH}`,
    )
  })

  it('can be overridden for a deployment behind a host-rewriting proxy', () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://public.example.com/oauth/google'
    expect(redirectUri('https://internal.invalid/api/google/connect')).toBe(
      'https://public.example.com/oauth/google',
    )
  })
})

describe('exchangeCode', () => {
  it('posts the code with the secret and the exact redirect URI Google will compare', async () => {
    const { impl, calls } = respondWith(grantBody)

    const grant = await exchangeCode('one-time-code', config, 'https://app.test/oauth/google', impl)

    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    expect(Object.fromEntries(calls[0]!.params)).toEqual({
      code: 'one-time-code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: 'https://app.test/oauth/google',
      grant_type: 'authorization_code',
    })
    expect(grant.refreshToken).toBe('1//refresh')
    expect(grant.accessToken).toBe('ya29.token')
    expect(grant.expiresIn).toBe(3599)
  })

  it('reports a grant with no refresh token rather than inventing one', async () => {
    // Google withholds it when it decides the existing grant still stands. The
    // access token is still usable, so this is not a failure — but the caller
    // has to know the connection will not outlive the hour.
    const { refresh_token: _unused, ...withoutRefresh } = grantBody
    const { impl } = respondWith(withoutRefresh)

    const grant = await exchangeCode('code', config, 'https://app.test/oauth/google', impl)

    expect(grant.refreshToken).toBeNull()
    expect(grant.accessToken).toBe('ya29.token')
  })

  it('defaults the lifetime when Google omits one', async () => {
    const { expires_in: _unused, ...withoutExpiry } = grantBody
    const { impl } = respondWith(withoutExpiry)

    expect((await exchangeCode('c', config, 'https://app.test/oauth/google', impl)).expiresIn).toBe(
      3600,
    )
  })

  it('raises a 502 for a refused exchange, carrying Google’s own reason', async () => {
    const { impl } = respondWith(
      { error: 'redirect_uri_mismatch', error_description: 'Bad Request' },
      400,
    )

    await expect(exchangeCode('c', config, 'https://app.test/oauth/google', impl)).rejects.toThrow(
      GoogleOauthError,
    )
    await expect(
      exchangeCode('c', config, 'https://app.test/oauth/google', impl),
    ).rejects.toMatchObject({ status: 502, code: 'redirect_uri_mismatch' })
  })

  it('treats a 200 with no access token as a failure', async () => {
    const { impl } = respondWith({ scope: 'drive.file' })

    await expect(exchangeCode('c', config, 'https://app.test/oauth/google', impl)).rejects.toThrow(
      GoogleOauthError,
    )
  })
})

describe('refreshAccessToken', () => {
  it('exchanges the stored token without sending the code grant fields', async () => {
    const { impl, calls } = respondWith(grantBody)

    await refreshAccessToken('1//refresh', config, impl)

    expect(Object.fromEntries(calls[0]!.params)).toEqual({
      refresh_token: '1//refresh',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    })
  })

  it('flags a dead refresh token as the user’s to fix, not a server fault', async () => {
    const { impl } = respondWith(
      { error: 'invalid_grant', error_description: 'Token revoked' },
      400,
    )

    // 409 rather than 502: nothing is broken here, the grant was withdrawn from
    // the Google account page. The caller drops the row and asks for consent.
    await expect(refreshAccessToken('1//dead', config, impl)).rejects.toMatchObject({
      status: 409,
      code: 'invalid_grant',
    })
  })

  it('survives a non-JSON response from an outage page', async () => {
    const impl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch

    await expect(refreshAccessToken('1//refresh', config, impl)).rejects.toMatchObject({
      code: 'token_request_failed',
    })
  })
})

describe('revokeToken', () => {
  it('swallows failures, because the local copy is already gone', async () => {
    const impl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await expect(revokeToken('1//refresh', impl)).resolves.toBeUndefined()
  })
})
