import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which token the Supabase client is handed, and when it is handed none.
 *
 * There is much less here than there was, and that is the change rather than a
 * gap in it. This module used to mint a session over `/api/session`, cache it,
 * share one in-flight attempt between concurrent callers and renew it early —
 * so most of its tests were about the caching, because a burst of queries
 * against an expired token was a burst of identical HTTP requests. Nothing is
 * minted now: Supabase trusts Auth0 directly, and auth0-spa-js holds and
 * refreshes the session.
 *
 * What is left is worth pinning down precisely because it is small. Handing
 * PostgREST the wrong one of Auth0's two tokens does not fail loudly — the
 * access token is signed by the same tenant and verifies fine, it simply lacks
 * the `role` claim Auth0 strips from it, and every query comes back empty as
 * though the account were new.
 */
const auth0IdToken = vi.fn<() => Promise<string | null>>()
const currentAccount = vi.fn<() => object | null>()

vi.mock('../auth0/client', () => ({
  auth0IdToken: () => auth0IdToken(),
  currentAccount: () => currentAccount(),
}))

const { SignInRequiredError, supabaseAccessToken } = await import('./session')

beforeEach(() => {
  auth0IdToken.mockResolvedValue('id-token')
  currentAccount.mockReturnValue({ id: 'google-oauth2|104372', email: 'someone@example.com' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('supabaseAccessToken', () => {
  it('hands over the Auth0 ID token, unaltered', async () => {
    // Unaltered is the point: PostgREST validates it against the tenant's own
    // published keys, so anything this side did to it would break the
    // signature.
    await expect(supabaseAccessToken()).resolves.toBe('id-token')
  })

  it('sends no token at all when nobody is signed in, which is not an error', async () => {
    // supabase-js reads null as "send the anon key alone", and row-level
    // security refuses that — which is the correct outcome for a signed-out
    // page. Throwing instead would turn every background query on such a page
    // into an error somebody has to handle.
    currentAccount.mockReturnValue(null)

    await expect(supabaseAccessToken()).resolves.toBeNull()
    expect(auth0IdToken).not.toHaveBeenCalled()
  })

  it('asks for a sign-in when the Auth0 session has run out', async () => {
    // auth0-spa-js rejects rather than returning null when a silent refresh is
    // refused, so a throw from underneath is what an expired refresh token
    // looks like from here.
    auth0IdToken.mockRejectedValue(new Error('login_required'))

    await expect(supabaseAccessToken()).rejects.toBeInstanceOf(SignInRequiredError)
  })

  it('reads the token per call rather than holding one of its own', async () => {
    // supabase-js calls this on every request, and the editor saves, syncs
    // assets and uploads at once. That was worth caching when each call was a
    // mint; now it is a read of the SDK's cache, and a second cache here could
    // only go stale against the session actually being refreshed underneath it.
    await supabaseAccessToken()
    await supabaseAccessToken()
    await supabaseAccessToken()

    expect(auth0IdToken).toHaveBeenCalledTimes(3)
  })
})
