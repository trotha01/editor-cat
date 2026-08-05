import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which of the two authorisation paths runs, and what happens when the first one
 * has nothing to offer.
 *
 * The stored connection is what makes Drive survive a reload; the GIS token flow
 * is the fallback for deployments that cannot store one. Getting the handover
 * between them wrong is invisible until someone reloads — either the app stops
 * resuming connections it could have resumed, or a build with no server behind
 * it stops working at all.
 */
const requestAccessToken = vi.fn()
const saveConnection = vi.fn()
const connectionStatus = vi.fn()
const clearConnection = vi.fn()
const requestAuthorizationCode = vi.fn()

class NoConnectionError extends Error {}
class ConnectionExpiredError extends Error {}
class NotDurableError extends Error {}
class SessionRequiredError extends Error {}
class ConsentDeclinedError extends Error {}

vi.mock('./connection', () => ({
  requestAccessToken: () => requestAccessToken() as unknown,
  saveConnection: (code: string) => saveConnection(code) as unknown,
  connectionStatus: () => connectionStatus() as unknown,
  clearConnection: () => clearConnection() as unknown,
  NoConnectionError,
  ConnectionExpiredError,
  NotDurableError,
  SessionRequiredError,
}))

vi.mock('./oauthPopup', () => ({
  requestAuthorizationCode: (...args: unknown[]) => requestAuthorizationCode(...args) as unknown,
  ConsentDeclinedError,
}))

const gis = await import('./gis')

const BOTH_SCOPES = gis.DRIVE_SCOPES

/** The GIS token client, which the fallback path drives. */
const gisRequest = vi.fn()

function installGis(): void {
  let onToken: ((response: unknown) => void) | undefined

  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: (config: { callback: (response: unknown) => void }) => {
          onToken = config.callback
          return {
            requestAccessToken: (options: { prompt: string }) => {
              gisRequest(options)
              onToken?.({ access_token: 'gis-token', expires_in: 3600, scope: BOTH_SCOPES })
            },
          }
        },
        hasGrantedAllScopes: () => true,
        revoke: (_token: string, done: () => void) => done(),
      },
    },
  })
}

const storedGrant = { accessToken: 'stored-token', expiresIn: 3600, scope: BOTH_SCOPES }

beforeEach(() => {
  vi.clearAllMocks()
  gis.resetForTests()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-abc.apps.googleusercontent.com')
  installGis()
  requestAccessToken.mockResolvedValue(storedGrant)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('accessToken', () => {
  it('mints from the stored connection first', async () => {
    await expect(gis.accessToken()).resolves.toBe('stored-token')
    expect(gisRequest).not.toHaveBeenCalled()
  })

  it('holds the token in memory rather than asking again for every upload', async () => {
    await gis.accessToken()
    await gis.accessToken()

    // Generating a batch of images fires several uploads at once; one token
    // request per file would be both slow and pointless.
    expect(requestAccessToken).toHaveBeenCalledOnce()
  })

  it('shares one renewal between concurrent callers', async () => {
    const [a, b] = await Promise.all([gis.accessToken(), gis.accessToken()])

    expect([a, b]).toEqual(['stored-token', 'stored-token'])
    expect(requestAccessToken).toHaveBeenCalledOnce()
  })

  it('falls back to Google when this account has never connected', async () => {
    requestAccessToken.mockRejectedValue(new NoConnectionError())

    await expect(gis.accessToken()).resolves.toBe('gis-token')
    // Silently: a load-time renewal must not throw a pop-up at anyone.
    expect(gisRequest).toHaveBeenCalledWith({ prompt: '' })
  })

  it('falls back, and stops asking, when the site cannot store connections', async () => {
    requestAccessToken.mockRejectedValue(new NotDurableError())

    await expect(gis.accessToken()).resolves.toBe('gis-token')
    expect(gis.isDurableConnection()).toBe(false)

    // The answer will not change within a session, so later renewals go
    // straight to Google rather than round-tripping a 503 each time.
    gis.invalidateToken()
    await gis.accessToken()
    expect(requestAccessToken).toHaveBeenCalledOnce()
  })

  it('keeps trying the stored connection after a session token is refused once', async () => {
    // A laptop waking from sleep presents a token that expired while it slept.
    // Giving up on the stored connection for the rest of the session over that
    // would send the user back to the Connect button for no reason.
    requestAccessToken.mockRejectedValueOnce(new SessionRequiredError())

    await expect(gis.accessToken()).resolves.toBe('gis-token')
    expect(gis.isDurableConnection()).not.toBe(false)

    gis.invalidateToken()
    await expect(gis.accessToken()).resolves.toBe('stored-token')
  })

  it('asks the user to reconnect when the stored connection was revoked', async () => {
    requestAccessToken.mockRejectedValue(new ConnectionExpiredError('Your connection expired.'))

    // Not silently retried against Google: only the user can put this right,
    // and the Drive store turns this error into the Reconnect button.
    await expect(gis.accessToken()).rejects.toBeInstanceOf(gis.NeedsConsentError)
    expect(gisRequest).not.toHaveBeenCalled()
  })

  it('refuses a stored grant that lost a scope', async () => {
    requestAccessToken.mockResolvedValue({
      accessToken: 'partial',
      expiresIn: 3600,
      scope: 'https://www.googleapis.com/auth/drive.file',
    })

    // Browsing needs the read scope. Better a clear message here than a 403
    // from the folder list once the user is halfway through choosing one.
    await expect(gis.accessToken()).rejects.toThrow(/partly granted/)
  })
})

describe('loadConnectionStatus', () => {
  it('settles which flow connect will use, before anyone can press the button', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: true, scope: '' })

    await expect(gis.loadConnectionStatus()).resolves.toEqual({ durable: true, connected: true })
    expect(gis.isDurableConnection()).toBe(true)
  })
})

describe('connect', () => {
  it('runs the consent pop-up and stores what comes back', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: false, scope: '' })
    await gis.loadConnectionStatus()

    requestAuthorizationCode.mockResolvedValue('one-time-code')
    saveConnection.mockResolvedValue({ ...storedGrant, durable: true })

    await expect(gis.connect()).resolves.toBe('stored-token')
    expect(saveConnection).toHaveBeenCalledWith('one-time-code')
    expect(gisRequest).not.toHaveBeenCalled()

    // And the token is live straight away, so choosing a folder needs no second
    // round trip.
    await expect(gis.accessToken()).resolves.toBe('stored-token')
    expect(requestAccessToken).not.toHaveBeenCalled()
  })

  it('uses the Google flow on a site that cannot store connections', async () => {
    connectionStatus.mockResolvedValue({ durable: false, connected: false, scope: '' })
    await gis.loadConnectionStatus()

    await expect(gis.connect()).resolves.toBe('gis-token')
    expect(requestAuthorizationCode).not.toHaveBeenCalled()
    expect(gisRequest).toHaveBeenCalledWith({ prompt: 'consent' })
  })

  it('recovers when the exchange reveals the site cannot store one after all', async () => {
    requestAuthorizationCode.mockResolvedValue('one-time-code')
    saveConnection.mockRejectedValue(new NotDurableError())

    // The consent just given cannot be used, so the flow Google understands runs
    // instead — rather than leaving the user with an error after agreeing.
    await expect(gis.connect()).resolves.toBe('gis-token')
    expect(gis.isDurableConnection()).toBe(false)
  })

  it('treats a closed consent window as a decision, not a fault', async () => {
    requestAuthorizationCode.mockRejectedValue(new ConsentDeclinedError('Window closed.'))

    await expect(gis.connect()).rejects.toBeInstanceOf(gis.NeedsConsentError)
  })
})

describe('disconnect', () => {
  it('drops the stored connection too, or the next load would resume it', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: true, scope: '' })
    await gis.loadConnectionStatus()
    await gis.accessToken()

    await gis.disconnect()

    expect(clearConnection).toHaveBeenCalled()
    expect(gis.hasToken()).toBe(false)
  })

  it('completes even when the server cannot be reached', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: true, scope: '' })
    await gis.loadConnectionStatus()
    clearConnection.mockRejectedValue(new Error('network down'))

    // The local token is already gone; the user's account page can revoke what
    // is left. Failing here would leave Settings stuck on "connected".
    await expect(gis.disconnect()).resolves.toBeUndefined()
  })
})
