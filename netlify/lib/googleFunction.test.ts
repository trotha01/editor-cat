import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The routing and bookkeeping in `netlify/functions/google.ts`.
 *
 * Lives here rather than beside the handler because Netlify turns every file in
 * the functions directory into a deployable endpoint — see functionNames.test.ts.
 *
 * The exchange itself is covered by googleOauth.test.ts, so Google is mocked out
 * entirely. What is worth pinning down here is the part that only exists in the
 * handler: which routes demand a session, and what happens when Google hands
 * back an access token but no refresh token.
 */
const requireSession = vi.fn()
const readConnection = vi.fn()
const writeConnection = vi.fn()
const deleteConnection = vi.fn()
const exchangeCode = vi.fn()
const refreshAccessToken = vi.fn()
const revokeToken = vi.fn()

class FakeGoogleOauthError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

class FakeMissingTableError extends Error {}

vi.mock('./auth', () => ({
  requireSession: (request: Request) => requireSession(request) as unknown,
}))

vi.mock('./googleConnections', () => ({
  storeConfig: () => ({ url: 'https://project.supabase.co', serviceKey: 'service-key' }),
  readConnection: (userId: string) => readConnection(userId) as unknown,
  writeConnection: (userId: string, connection: unknown) =>
    writeConnection(userId, connection) as unknown,
  deleteConnection: (userId: string) => deleteConnection(userId) as unknown,
  MissingTableError: FakeMissingTableError,
}))

vi.mock('./googleOauth', () => ({
  oauthConfig: () => ({ clientId: 'client-abc', clientSecret: 'secret-xyz' }),
  redirectUri: (requestUrl: string) => `${new URL(requestUrl).origin}/oauth/google`,
  exchangeCode: (code: string) => exchangeCode(code) as unknown,
  refreshAccessToken: (token: string) => refreshAccessToken(token) as unknown,
  revokeToken: (token: string) => revokeToken(token) as unknown,
  GoogleOauthError: FakeGoogleOauthError,
}))

const handler = (await import('../functions/google')).default

const SIGNED_IN = { ok: true, userId: 'user_42' }
const SIGNED_OUT = { ok: false, response: new Response('nope', { status: 401 }) }

const grant = { accessToken: 'ya29.token', expiresIn: 3599, scope: 'drive.file' }

function call(route: string, init: RequestInit = {}): Promise<Response> {
  return handler(new Request(`https://editor.test/api/google/${route}`, init))
}

const post = (route: string, body?: unknown): Promise<Response> =>
  call(route, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue(SIGNED_IN)
  readConnection.mockResolvedValue(null)
  writeConnection.mockResolvedValue(undefined)
  deleteConnection.mockResolvedValue(undefined)
  revokeToken.mockResolvedValue(undefined)
})

describe('status', () => {
  it('answers a signed-out caller, because the sign-in screen asks before there is a session', () => {
    requireSession.mockResolvedValue(SIGNED_OUT)

    // Signing in requests Drive at the same time, so the screen has to know
    // whether this deployment supports that *before* anyone has a token.
    return expect(call('status').then((r) => r.json())).resolves.toEqual({
      durable: true,
      connected: false,
    })
  })

  it('reports a stored connection for a caller who has one', async () => {
    readConnection.mockResolvedValue({ refreshToken: '1//refresh', scope: 'drive.file' })

    await expect(call('status').then((r) => r.json())).resolves.toEqual({
      durable: true,
      connected: true,
    })
  })

  it('never says anything about a user without checking their token first', async () => {
    requireSession.mockResolvedValue(SIGNED_OUT)

    await call('status')

    expect(readConnection).not.toHaveBeenCalled()
  })

  /**
   * A store that cannot be read used to come back as a 502, which the browser
   * could only render as "this site is not set up" — the same words it uses for
   * missing environment variables. Whoever deployed it then went and re-checked
   * the variables, which were fine, while the actual gap went unnamed.
   */
  describe('when the store cannot be read', () => {
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // The reason belongs in the function log, where the operator can see the
      // whole PostgREST body. Silenced here only to keep the run readable.
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    it('names the unrun migration, so the fix is the thing that is actually wrong', async () => {
      readConnection.mockRejectedValue(new FakeMissingTableError('relation does not exist'))

      const response = await call('status')

      // 200, not 502: "no, because the table is missing" is an answer to the
      // question, and a 502 would collapse it back into "something went wrong".
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        durable: false,
        connected: false,
        problem: 'no-table',
      })
      expect(String(warn.mock.calls[0]?.[0])).toContain('0002_google_connections.sql')
    })

    it('separates a store that is merely down from one that was never migrated', async () => {
      // Distinct because the advice differs: one is "reload in a minute", the
      // other is "nobody will ever get in until someone runs the migration".
      readConnection.mockRejectedValue(new Error('503 upstream connect error'))

      const response = await call('status')

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        durable: false,
        connected: false,
        problem: 'unreachable',
      })
    })
  })
})

describe('the routes that touch a stored connection', () => {
  it('refuse a caller whose session did not verify', async () => {
    requireSession.mockResolvedValue(SIGNED_OUT)

    for (const route of ['connect', 'token', 'disconnect']) {
      expect((await post(route, { code: 'c' })).status).toBe(401)
    }
    expect(readConnection).not.toHaveBeenCalled()
    expect(writeConnection).not.toHaveBeenCalled()
  })

  it('refuse anonymous development builds, which have no account to file one under', async () => {
    requireSession.mockResolvedValue({ ok: true, userId: null })

    expect((await post('token')).status).toBe(503)
  })

  it('refuse the wrong method, so a stray GET cannot look like a disconnect', async () => {
    expect((await call('disconnect')).status).toBe(405)
    expect(deleteConnection).not.toHaveBeenCalled()
  })

  it('answer 404 for a route that does not exist', async () => {
    expect((await post('nonsense')).status).toBe(404)
  })
})

describe('connect', () => {
  it('stores the refresh token and returns only the access token', async () => {
    exchangeCode.mockResolvedValue({ ...grant, refreshToken: '1//refresh' })

    const body = (await post('connect', { code: 'one-time-code' }).then((r) => r.json())) as Record<
      string,
      unknown
    >

    expect(writeConnection).toHaveBeenCalledWith('user_42', {
      refreshToken: '1//refresh',
      scope: 'drive.file',
    })
    expect(body).toEqual({
      access_token: 'ya29.token',
      expires_in: 3599,
      scope: 'drive.file',
      durable: true,
    })
    // The whole point of putting this behind a function: the long-lived half
    // must never appear in something the browser can read.
    expect(JSON.stringify(body)).not.toContain('1//refresh')
  })

  it('keeps the previous token when Google decides the grant still stands', async () => {
    exchangeCode.mockResolvedValue({ ...grant, refreshToken: null })
    readConnection.mockResolvedValue({ refreshToken: '1//earlier', scope: 'drive.file' })

    const body = (await post('connect', { code: 'c' }).then((r) => r.json())) as {
      durable: boolean
    }

    expect(writeConnection).not.toHaveBeenCalled()
    expect(body.durable).toBe(true)
  })

  it('says the connection is not durable when there is no token to fall back on', async () => {
    // The access token still works, so this is not a failure — but the browser
    // has to be told now rather than discovering it an hour later.
    exchangeCode.mockResolvedValue({ ...grant, refreshToken: null })
    readConnection.mockResolvedValue(null)

    const body = (await post('connect', { code: 'c' }).then((r) => r.json())) as {
      durable: boolean
    }

    expect(body.durable).toBe(false)
  })

  it('rejects a request with no readable code rather than calling Google', async () => {
    expect((await post('connect', { code: '  ' })).status).toBe(400)
    expect((await post('connect')).status).toBe(400)
    expect(exchangeCode).not.toHaveBeenCalled()
  })
})

describe('token', () => {
  it('mints an access token from the stored refresh token', async () => {
    readConnection.mockResolvedValue({ refreshToken: '1//refresh', scope: 'drive.file' })
    refreshAccessToken.mockResolvedValue({ ...grant, refreshToken: null })

    const response = await post('token')

    expect(refreshAccessToken).toHaveBeenCalledWith('1//refresh')
    expect(await response.json()).toEqual({
      access_token: 'ya29.token',
      expires_in: 3599,
      scope: 'drive.file',
    })
    // Nothing between here and the browser should keep a copy.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('falls back to the recorded scopes when a refresh response omits them', async () => {
    readConnection.mockResolvedValue({ refreshToken: '1//refresh', scope: 'recorded-at-connect' })
    refreshAccessToken.mockResolvedValue({ ...grant, scope: '', refreshToken: null })

    const body = (await post('token').then((r) => r.json())) as { scope: string }

    // An empty scope would read as a partial grant in the browser and take the
    // user to a reconnect button for no reason.
    expect(body.scope).toBe('recorded-at-connect')
  })

  it('answers 404 for an account that has simply never connected', async () => {
    readConnection.mockResolvedValue(null)

    // Not an error: it is the ordinary state of a new user, and the browser
    // treats it as "offer the button".
    expect((await post('token')).status).toBe(404)
  })

  it('drops a refresh token Google has stopped honouring', async () => {
    readConnection.mockResolvedValue({ refreshToken: '1//revoked', scope: 'drive.file' })
    refreshAccessToken.mockRejectedValue(
      new FakeGoogleOauthError(409, 'invalid_grant', 'Token revoked'),
    )

    const response = await post('token')

    // Keeping it would mean retrying forever against a dead credential, and
    // resuming a connection on every load that cannot work.
    expect(deleteConnection).toHaveBeenCalledWith('user_42')
    expect(response.status).toBe(409)
  })
})

describe('disconnect', () => {
  it('forgets the connection before telling Google, so a hang there still disconnects', async () => {
    readConnection.mockResolvedValue({ refreshToken: '1//refresh', scope: 'drive.file' })

    const response = await post('disconnect')

    expect(deleteConnection).toHaveBeenCalledWith('user_42')
    expect(revokeToken).toHaveBeenCalledWith('1//refresh')
    // Order is the point, not just that both ran: revocation is a courtesy to
    // the user's Google account page, and if it stalls or fails this site must
    // already have lost its own ability to reach their Drive.
    expect(deleteConnection.mock.invocationCallOrder[0]).toBeLessThan(
      revokeToken.mock.invocationCallOrder[0] as number,
    )
    expect(response.status).toBe(204)
  })

  it('is happy to disconnect an account that was not connected', async () => {
    readConnection.mockResolvedValue(null)

    expect((await post('disconnect')).status).toBe(204)
    expect(revokeToken).not.toHaveBeenCalled()
  })
})
