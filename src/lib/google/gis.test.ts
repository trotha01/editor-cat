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

const storedGrant = { accessToken: 'stored-token', expiresIn: 3600, scope: gis.DRIVE_SCOPES }

beforeEach(() => {
  vi.clearAllMocks()
  gis.resetForTests()
  requestAccessToken.mockResolvedValue(storedGrant)
  clearConnection.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('DRIVE_SCOPES', () => {
  it('asks for no restricted scope, which is what the Picker buys', () => {
    // `drive.readonly` reads as "See and download all your Google Drive files"
    // on the consent screen and needs Google's annual third-party security
    // assessment before that screen can be published. The Picker hands over the
    // files the user chose instead, so this must never creep back.
    expect(gis.DRIVE_SCOPES).not.toContain('drive.readonly')
    expect(gis.DRIVE_SCOPES).not.toContain('auth/drive ')
    expect(gis.DRIVE_SCOPE_LIST).toEqual(['https://www.googleapis.com/auth/drive.file'])
  })

  it('asks for nothing about identity, which Netlify Identity now owns', () => {
    // These were here when one consent screen did both jobs. Asking for them now
    // would mean requesting an ID token nothing reads, from a screen whose only
    // purpose is the folder.
    expect(gis.DRIVE_SCOPES).not.toContain('openid')
    expect(gis.DRIVE_SCOPES).not.toContain('email')
    expect(gis.DRIVE_SCOPES).not.toContain('profile')
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

  it('refuses a stored grant that came back without Drive', async () => {
    requestAccessToken.mockResolvedValue({
      accessToken: 'no-drive',
      expiresIn: 3600,
      scope: 'openid email',
    })

    // Better a clear message here than a 403 from the first upload, long after
    // the user has stopped connecting anything to the cause.
    await expect(gis.accessToken()).rejects.toThrow(/was not granted/)
  })
})

describe('loadConnectionStatus', () => {
  it('settles whether this site can sign anyone in at all', async () => {
    connectionStatus.mockResolvedValue({ durable: true, connected: true })

    await expect(gis.loadConnectionStatus()).resolves.toEqual({ durable: true, connected: true })
    expect(gis.isDurableConnection()).toBe(true)
  })
})
