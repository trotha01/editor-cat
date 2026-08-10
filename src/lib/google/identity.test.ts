import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the Drive step actually asks Google for.
 *
 * The scopes are threaded from `DRIVE_SCOPE_LIST` through
 * `requestDriveAuthorization` into the authorisation request, and every link is
 * somewhere different. Testing the URL builder alone proved nothing about the
 * path the button takes — which is exactly where a missing Drive scope would
 * leave someone signed in and unable to save a single frame.
 */
const requestAuthorization = vi.fn()

vi.mock('./oauthPopup', () => ({
  requestAuthorization: (request: unknown) => requestAuthorization(request) as unknown,
  ConsentDeclinedError: class extends Error {},
}))

const { requestDriveAuthorization } = await import('./identity')
const { DRIVE_SCOPE_LIST } = await import('./gis')

/** The single argument `requestDriveAuthorization` handed to the pop-up. */
function sentRequest(): { clientId: string; scope: string; prompt?: string; loginHint?: string } {
  return requestAuthorization.mock.calls[0]?.[0] as ReturnType<typeof sentRequest>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-abc.apps.googleusercontent.com')
  requestAuthorization.mockResolvedValue({ code: 'one-time-code' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requestDriveAuthorization', () => {
  it('asks for every Drive scope, or the editor has nowhere to save', async () => {
    await requestDriveAuthorization()

    const granted = sentRequest().scope.split(' ')
    for (const scope of DRIVE_SCOPE_LIST) {
      expect(granted).toContain(scope)
    }
  })

  it('re-asks for consent, or the grant carries no refresh token', async () => {
    await requestDriveAuthorization()

    expect(sentRequest().prompt).toContain('consent')
  })

  it('hints the account already signed in, so Google does not ask twice', async () => {
    // The whole cost of splitting sign-in from Drive is one extra screen. It
    // becomes two if Google also makes the user pick the account again.
    await requestDriveAuthorization('someone@example.com')

    expect(sentRequest().loginHint).toBe('someone@example.com')
  })

  it('sends no hint when there is no address to send', async () => {
    await requestDriveAuthorization()

    expect(sentRequest().loginHint).toBeUndefined()
  })

  it('returns the code, which only the function can spend', async () => {
    await expect(requestDriveAuthorization()).resolves.toBe('one-time-code')
  })

  it('says so plainly when the site has no Google client ID', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '')

    await expect(requestDriveAuthorization()).rejects.toThrow(/VITE_GOOGLE_CLIENT_ID/)
    expect(requestAuthorization).not.toHaveBeenCalled()
  })
})
