import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the gate depends on the auth store getting right.
 *
 * This used to drive the real gotrue-js against a seeded localStorage, because
 * surviving a reload was a property of *our* wiring: the `remember` flag, the
 * redirect fragment, the order of the calls. Under Auth0 that half belongs to
 * auth0-spa-js, which persists and refreshes its own session behind
 * `adoptRedirect`. What is left to protect is the store's own contract, so the
 * client is mocked and the store is what gets exercised.
 *
 * The part worth guarding is that `start` asks for a token before reporting
 * success. It used to be trading the Auth0 session for a minted Supabase one;
 * with Supabase trusting Auth0 directly there is nothing to trade, but the call
 * is still a silent refresh — and a session whose refresh token has run out
 * looks exactly like a good one until something makes that call. The difference
 * between the two must not be discovered by the first save after the editor
 * opens.
 */
const adoptRedirect = vi.fn()
const beginGoogleSignIn = vi.fn()
const auth0SignOut = vi.fn()
const supabaseAccessToken = vi.fn()

vi.mock('../lib/auth0/client', () => ({
  adoptRedirect: () => adoptRedirect(),
  beginGoogleSignIn: () => beginGoogleSignIn(),
  auth0SignOut: () => auth0SignOut(),
}))

vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))
vi.mock('../lib/mock', () => ({ isMockEnabled: () => false }))

vi.mock('../lib/supabase/session', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/supabase/session')>('../lib/supabase/session')
  return {
    ...actual,
    supabaseAccessToken: () => supabaseAccessToken(),
  }
})

const ACCOUNT = { id: 'auth0|42', email: 'someone@example.com' }

let useAuthStore: typeof import('./useAuthStore').useAuthStore
let SignInRequiredError: typeof import('../lib/supabase/session').SignInRequiredError

beforeEach(async () => {
  vi.resetModules()
  adoptRedirect.mockResolvedValue(ACCOUNT)
  beginGoogleSignIn.mockResolvedValue(undefined)
  auth0SignOut.mockResolvedValue(undefined)
  supabaseAccessToken.mockResolvedValue('supabase-token')
  ;({ useAuthStore } = await import('./useAuthStore'))
  ;({ SignInRequiredError } = await import('../lib/supabase/session'))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('start', () => {
  it('adopts a redirect or a stored session through one call', async () => {
    // Auth0 comes back with `code` and `state` in the query string, and a
    // returning visit has neither — `adoptRedirect` covers both, so the store
    // does not have to know which happened.
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(useAuthStore.getState().account).toEqual(ACCOUNT)
    expect(adoptRedirect).toHaveBeenCalledOnce()
  })

  it('asks for the token before reporting success', async () => {
    await useAuthStore.getState().start()
    expect(supabaseAccessToken).toHaveBeenCalledOnce()
  })

  it('treats a session that cannot produce a token as signed out', async () => {
    // An Auth0 session whose refresh token has run out looks valid until it is
    // asked for one. Finding out here is the whole point of asking eagerly.
    supabaseAccessToken.mockRejectedValue(new SignInRequiredError())

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().account).toBeNull()
  })

  it('keeps a good session when the failure is not one signing in again fixes', async () => {
    // Nothing is expected to land here now that no server has to answer for a
    // token to exist. The branch stays because an unforeseen failure should
    // reach the gate as something it can show, rather than sending someone back
    // round a loop that was never the problem.
    supabaseAccessToken.mockRejectedValue(new Error('something unforeseen'))

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(useAuthStore.getState().error).toMatch(/something unforeseen/)
  })

  it('reports a refused consent rather than throwing out of the effect', async () => {
    adoptRedirect.mockRejectedValue(new Error('access_denied'))

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().error).toMatch(/access_denied/)
  })

  it('signs nobody in when there was no session to adopt', async () => {
    adoptRedirect.mockResolvedValue(null)

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(supabaseAccessToken).not.toHaveBeenCalled()
  })
})

describe('signIn', () => {
  it('leaves for Google, holding the gate on a spinner while it goes', async () => {
    useAuthStore.getState().signIn()

    expect(useAuthStore.getState().status).toBe('signing-in')
    expect(beginGoogleSignIn).toHaveBeenCalledOnce()
  })

  it('recovers when the redirect never happens', async () => {
    // Otherwise the gate spins at `signing-in` forever with nothing to show, on
    // a page that is not going anywhere.
    beginGoogleSignIn.mockRejectedValue(new Error('popup blocked'))

    useAuthStore.getState().signIn()
    await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('signed-out'))

    expect(useAuthStore.getState().error).toMatch(/popup blocked/)
  })
})

describe('signOut', () => {
  it('ends the session locally even when Auth0 cannot be reached', async () => {
    // There is no separate credential to drop here any more — the token is
    // auth0-spa-js's, and `auth0SignOut` clears its cache. What still has to
    // hold is that a failed round trip does not leave the store claiming
    // somebody is signed in.
    auth0SignOut.mockRejectedValue(new Error('network'))

    await useAuthStore.getState().signOut()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().account).toBeNull()
    expect(useAuthStore.getState().error).toMatch(/network/)
  })
})
