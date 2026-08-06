import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Turning a stored connection into a usable Drive token.
 *
 * There is only one way to get one now, so the interesting behaviour is what
 * happens when it fails. Every failure means the same thing to the user — sign in
 * again — and this is where four different errors are collapsed into that one
 * answer. Get it wrong and a token that simply needs renewing looks like a fault,
 * or a revoked grant retries silently forever.
 */
const requestAccessToken = vi.fn()
const saveConnection = vi.fn()
const connectionStatus = vi.fn()
const clearConnection = vi.fn()

class NoConnectionError extends Error {}
class ConnectionExpiredError extends Error {}
class NotDurableError extends Error {}
class SessionRequiredError extends Error {}

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

const gis = await import('./gis')

const BOTH_SCOPES = gis.DRIVE_SCOPES
const storedGrant = { accessToken: 'stored-token', expiresIn: 3600, scope: BOTH_SCOPES }

beforeEach(() => {
  vi.clearAllMocks()
  gis.resetForTests()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-abc.apps.googleusercontent.com')
  requestAccessToken.mockResolvedValue(storedGrant)
  clearConnection.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SIGN_IN_SCOPES', () => {
  it('carries Drive, because signing in is the only time this app asks for it', () => {
    const asked = gis.SIGN_IN_SCOPES.split(' ')

    for (const scope of gis.DRIVE_SCOPE_LIST) expect(asked).toContain(scope)
    expect(asked).toContain('openid')
  })
})

describe('accessToken', () => {
  it('mints from the stored connection', async () => {
    await expect(gis.accessToken()).resolves.toBe('stored-token')
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

  it('answers every way of having no connection with "sign in again"', async () => {
    // Never connected, connection revoked, session token refused, site not set
    // up: four causes, one thing the user can do about any of them. Callers
    // should not each have to know the difference.
    for (const cause of [
      new NoConnectionError('none stored'),
      new ConnectionExpiredError('revoked'),
      new SessionRequiredError('stale session'),
      new NotDurableError('not configured'),
    ]) {
      gis.resetForTests()
      requestAccessToken.mockRejectedValue(cause)

      await expect(gis.accessToken()).rejects.toBeInstanceOf(gis.NeedsConsentError)
    }
  })

  it('lets an unrecognised failure through as itself', async () => {
    requestAccessToken.mockRejectedValue(new Error('Drive is on fire'))

    // Only the four above mean "sign in again". Dressing everything up that way
    // would send people round a consent flow that cannot help them.
    await expect(gis.accessToken()).rejects.toThrow('Drive is on fire')
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
  it('settles whether this site can sign anyone in at all', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: true })

    await expect(gis.loadConnectionStatus()).resolves.toEqual({ durable: true, connected: true })
    expect(gis.isDurableConnection()).toBe(true)
  })
})

describe('adoptConnection', () => {
  it('turns a code from the sign-in screen into a live connection', async () => {
    saveConnection.mockResolvedValue({ ...storedGrant, durable: true })

    await expect(gis.adoptConnection('sign-in-code')).resolves.toBe('stored-token')
    expect(gis.hasToken()).toBe(true)
    expect(gis.isDurableConnection()).toBe(true)
  })

  it('drops a grant that arrived without the Drive permissions', async () => {
    // Google's consent screen lets the Drive scopes be unticked, which signs the
    // user in with a connection that can do nothing. Keeping it would mean
    // resuming it on every load and failing the same way each time.
    saveConnection.mockResolvedValue({
      accessToken: 'partial',
      expiresIn: 3600,
      scope: 'openid email',
      durable: true,
    })

    await expect(gis.adoptConnection('sign-in-code')).rejects.toThrow(/partly granted/)
    expect(clearConnection).toHaveBeenCalled()
    expect(gis.hasToken()).toBe(false)
  })
})
