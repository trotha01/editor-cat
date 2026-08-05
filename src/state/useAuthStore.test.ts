import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sign-in has to survive a reload.
 *
 * The whole mechanism is a Supabase client configured to persist its session
 * plus a `start()` that reads it back, which is easy to break silently: a
 * `persistSession: false` slipped into the client options, a storage override, a
 * `signOut()` on some unrelated failure path. None of that shows up in the
 * editor until someone closes the tab and finds themselves at the sign-in screen
 * again.
 *
 * So this exercises the real client against a seeded localStorage rather than a
 * mocked `supabase.auth`, because a mock of the thing being tested would prove
 * nothing. Nothing here touches the network: the seeded session is well inside
 * its lifetime, so there is nothing for the client to refresh.
 */
const PROJECT_URL = 'https://persistedproject.supabase.co'
const STORAGE_KEY = 'sb-persistedproject-auth-token'

const HOUR = 60 * 60

function storedSession(expiresInSeconds = HOUR) {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  return {
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    token_type: 'bearer',
    expires_in: expiresInSeconds,
    expires_at: expiresAt,
    user: {
      id: 'user_42',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'someone@example.com',
      app_metadata: { provider: 'google' },
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  }
}

/** Imports the store fresh, so its module-level env reads happen under the stubs. */
async function loadStore() {
  const { resetForTests } = await import('../lib/supabase/client')
  resetForTests()
  vi.resetModules()
  return await import('./useAuthStore')
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', PROJECT_URL)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-tests')
  vi.stubEnv('VITE_MOCK_PROVIDERS', '')
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  window.localStorage.clear()
})

describe('a configured build', () => {
  it('starts out checking rather than signed out, so a stored session is not flashed past', async () => {
    const { useAuthStore, requiresSignIn } = await loadStore()

    expect(requiresSignIn()).toBe(true)
    expect(useAuthStore.getState().status).toBe('checking')
  })

  it('restores the session left behind by a previous visit', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession()))

    const { useAuthStore, currentUserId, currentAccessToken } = await loadStore()
    const unsubscribe = await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(currentUserId()).toBe('user_42')
    // What the fal proxy is sent. Read through the store rather than captured,
    // so a token refreshed mid-session is picked up.
    expect(currentAccessToken()).toBe('stored-access-token')

    unsubscribe()
  })

  it('asks for a sign-in when there is nothing stored', async () => {
    const { useAuthStore } = await loadStore()
    const unsubscribe = await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')

    unsubscribe()
  })

  it('does not treat unreadable stored data as a session', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')

    const { useAuthStore } = await loadStore()
    const unsubscribe = await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')

    unsubscribe()
  })

  it('keeps signing in with Google out of local storage as a raw credential', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession()))

    const { useAuthStore } = await loadStore()
    const unsubscribe = await useAuthStore.getState().start()

    // The session token is stored — that is the point — but the Google ID token
    // that produced it is single-use and must not be lying around next to it.
    expect(JSON.stringify(window.localStorage)).not.toContain('id_token')

    unsubscribe()
  })
})

describe('an unconfigured build', () => {
  it('opens the editor without a gate, so a fresh clone runs', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    const { useAuthStore, requiresSignIn } = await loadStore()

    expect(requiresSignIn()).toBe(false)
    expect(useAuthStore.getState().status).toBe('local')

    // Safe to call regardless: App mounts before knowing which build this is.
    const unsubscribe = await useAuthStore.getState().start()
    expect(useAuthStore.getState().status).toBe('local')
    unsubscribe()
  })
})
