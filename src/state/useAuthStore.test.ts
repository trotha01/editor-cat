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
 * The part worth guarding is the mint. `start` deliberately trades the Auth0
 * session for a Supabase one before reporting success, because a session whose
 * refresh token has run out looks exactly like a good one until something asks
 * it for a token — and the difference between the two must not be discovered by
 * the first save after the editor opens.
 */
const adoptRedirect = vi.fn()
const beginGoogleSignIn = vi.fn()
const auth0SignOut = vi.fn()
const supabaseAccessToken = vi.fn()
const clearSupabaseSession = vi.fn()

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
    clearSupabaseSession: () => clearSupabaseSession(),
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

  it('mints the Supabase session before reporting success', async () => {
    await useAuthStore.getState().start()
    expect(supabaseAccessToken).toHaveBeenCalledOnce()
  })

  it('treats a session that cannot mint as signed out', async () => {
    // An Auth0 session whose refresh token has run out looks valid until it is
    // asked for a token. Finding out here is the whole point of minting eagerly.
    supabaseAccessToken.mockRejectedValue(new SignInRequiredError())

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().account).toBeNull()
  })

  it('keeps a good session when the deployment is the thing that is broken', async () => {
    // A missing signing secret is not fixed by signing in again, so the gate is
    // told what happened rather than being sent round the loop once more.
    supabaseAccessToken.mockRejectedValue(new Error('SUPABASE_JWT_SECRET is not set'))

    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(useAuthStore.getState().error).toMatch(/SUPABASE_JWT_SECRET/)
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
  it('drops the Supabase session first, and unconditionally', async () => {
    // It is a live credential for this account's rows, and it has to be gone
    // whether or not the round trip to Auth0 succeeds.
    auth0SignOut.mockRejectedValue(new Error('network'))

    await useAuthStore.getState().signOut()

    expect(clearSupabaseSession).toHaveBeenCalledOnce()
    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().account).toBeNull()
  })
})
