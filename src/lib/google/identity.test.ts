import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What signing in actually asks Google for.
 *
 * The scopes are threaded from `SIGN_IN_SCOPES` through `requestSignIn` into the
 * authorisation request, and every link is somewhere different. Testing the URL
 * builder alone proved nothing about the path the sign-in button takes — which
 * is exactly where a missing Drive scope would leave the user signed in and
 * still looking at a "Allow Google Drive" button in Settings.
 */
const requestAuthorization = vi.fn()

vi.mock('./oauthPopup', () => ({
  requestAuthorization: (request: unknown) => requestAuthorization(request) as unknown,
  ConsentDeclinedError: class extends Error {},
}))

const { requestSignIn } = await import('./identity')
const { DRIVE_SCOPE_LIST } = await import('./gis')

const nonce = { raw: 'raw-nonce', hashed: 'hashed-nonce' }

/** The single argument `requestSignIn` handed to the pop-up. */
function sentRequest(): { clientId: string; scope: string; nonce?: string; prompt?: string } {
  return requestAuthorization.mock.calls[0]?.[0] as ReturnType<typeof sentRequest>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-abc.apps.googleusercontent.com')
  requestAuthorization.mockResolvedValue({ code: 'one-time-code', idToken: 'signed.id.token' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requestSignIn', () => {
  it('asks for every Drive scope, so no separate step is left in Settings', async () => {
    await requestSignIn(nonce)

    const granted = sentRequest().scope.split(' ')
    for (const scope of DRIVE_SCOPE_LIST) {
      expect(granted).toContain(scope)
    }
  })

  it('asks for identity in the same request, since that is the whole point', async () => {
    await requestSignIn(nonce)

    // `openid` is what makes Google return an ID token at all; without `email`
    // Supabase has nothing to build an account from.
    const granted = sentRequest().scope.split(' ')
    expect(granted).toContain('openid')
    expect(granted).toContain('email')
  })

  it('sends the hashed nonce, which is what switches on the ID token', async () => {
    await requestSignIn(nonce)

    // Google signs this value into the token; Supabase re-hashes the raw half
    // and compares. Sending the raw one here would hand Google the secret.
    expect(sentRequest().nonce).toBe('hashed-nonce')
    expect(sentRequest().nonce).not.toBe(nonce.raw)
  })

  it('re-asks for consent, or the grant carries no refresh token', async () => {
    await requestSignIn(nonce)

    expect(sentRequest().prompt).toContain('consent')
  })

  it('returns both halves: the session token and the Drive code', async () => {
    await expect(requestSignIn(nonce)).resolves.toEqual({
      idToken: 'signed.id.token',
      code: 'one-time-code',
    })
  })

  it('refuses to report a sign-in when Google returned no ID token', async () => {
    requestAuthorization.mockResolvedValue({ code: 'one-time-code' })

    await expect(requestSignIn(nonce)).rejects.toThrow(/did not return a sign-in token/)
  })

  it('says so plainly when the site has no Google client ID', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '')

    await expect(requestSignIn(nonce)).rejects.toThrow(/VITE_GOOGLE_CLIENT_ID/)
    expect(requestAuthorization).not.toHaveBeenCalled()
  })
})
