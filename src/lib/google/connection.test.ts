import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectionExpiredError,
  NotDurableError,
  SessionRequiredError,
  connectionStatus,
  requestAccessToken,
} from './connection'

const auth0Token = vi.fn<() => Promise<string | null>>()

vi.mock('../auth0/client', () => ({
  auth0Token: () => auth0Token(),
}))

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  auth0Token.mockResolvedValue('auth0-token')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('connectionStatus', () => {
  it('carries the Auth0 token, which is the subject of the exchange behind it', async () => {
    // The access token, not the ID token Supabase is given: Auth0 will only
    // trade a token it issued for this API itself.
    fetchMock.mockResolvedValue(answer({ durable: true, connected: true }))

    await expect(connectionStatus()).resolves.toEqual({ durable: true, connected: true })
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: 'Bearer auth0-token' },
    })
  })

  it('still asks about the deployment when nobody is signed in', async () => {
    // Whether the site can reach Drive at all needs no token, and the gate has
    // to know before it draws a button.
    auth0Token.mockResolvedValue(null)
    fetchMock.mockResolvedValue(
      answer({ durable: false, connected: false, problem: 'not-configured' }),
    )

    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'not-configured',
    })
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ headers: {} })
  })

  it('treats every way of not getting an answer as unreachable', async () => {
    // None of them is evidence about how the site is configured, and reporting
    // one as `not-configured` would send someone to check settings that are fine.
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'unreachable',
    })

    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }))
    await expect(connectionStatus()).resolves.toEqual({
      durable: false,
      connected: false,
      problem: 'unreachable',
    })
  })

  it('ignores a problem it does not recognise', async () => {
    fetchMock.mockResolvedValue(answer({ durable: false, connected: false, problem: 'wat' }))
    await expect(connectionStatus()).resolves.toEqual({ durable: false, connected: false })
  })
})

describe('requestAccessToken', () => {
  it('returns the Google token the exchange produced', async () => {
    fetchMock.mockResolvedValue(
      answer({ accessToken: 'ya29.token', expiresIn: 3599, scope: 'drive.file' }),
    )

    await expect(requestAccessToken()).resolves.toEqual({
      accessToken: 'ya29.token',
      expiresIn: 3599,
      scope: 'drive.file',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/google/token')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('asks for a sign-in rather than a token when there is no session', async () => {
    auth0Token.mockResolvedValue(null)
    await expect(requestAccessToken()).rejects.toBeInstanceOf(SessionRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tells a lapsed grant apart from a broken deployment', async () => {
    // 409 is the user's to fix by signing in again; 503 is the operator's. The
    // gate shows a different screen for each, so they must not collapse.
    fetchMock.mockResolvedValue(answer({ error: 'expired' }, 409))
    await expect(requestAccessToken()).rejects.toBeInstanceOf(ConnectionExpiredError)

    fetchMock.mockResolvedValue(answer({ error: 'no vault' }, 503))
    await expect(requestAccessToken()).rejects.toBeInstanceOf(NotDurableError)

    fetchMock.mockResolvedValue(answer({ error: 'nope' }, 401))
    await expect(requestAccessToken()).rejects.toBeInstanceOf(SessionRequiredError)
  })

  it('falls back to an hour when the exchange does not say how long', async () => {
    fetchMock.mockResolvedValue(answer({ accessToken: 'ya29.token' }))
    await expect(requestAccessToken()).resolves.toMatchObject({ expiresIn: 3600, scope: '' })
  })
})
