import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { User } from 'gotrue-js'

/**
 * Sign-in has to survive a reload.
 *
 * The whole mechanism is gotrue-js persisting its session plus a `start()` that
 * reads it back and trades it for a Supabase one, which is easy to break
 * silently: a `remember` flag dropped from `createUser`, a `logout()` on some
 * unrelated failure path, a mint that throws and is treated as a dead session.
 * None of that shows up in the editor until someone closes the tab and finds
 * themselves at the sign-in screen again.
 *
 * So this exercises the real gotrue-js client against a seeded localStorage
 * rather than a mocked identity module, because a mock of the thing being tested
 * would prove nothing. Only the network is faked.
 */
const PROJECT_URL = 'https://persistedproject.supabase.co'
const IDENTITY_STORAGE_KEY = 'gotrue.user'

const HOUR = 60 * 60

function identityUrl(): string {
  return `${window.location.origin}/.netlify/identity`
}

/** A JWT gotrue-js can read an expiry out of. Never verified by anything here. */
function fakeJwt(expiresInSeconds: number): string {
  const claims = { sub: 'netlify-user-42', exp: Math.floor(Date.now() / 1000) + expiresInSeconds }
  const segment = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '')
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.signature`
}

function tokenResponse(expiresInSeconds = HOUR) {
  return {
    access_token: fakeJwt(expiresInSeconds),
    refresh_token: 'stored-refresh-token',
    token_type: 'bearer',
    expires_in: expiresInSeconds,
    expires_at: Date.now() + expiresInSeconds * 1000,
  }
}

/** The shape gotrue-js writes to localStorage, and reads back on the next load. */
function storedIdentitySession() {
  return {
    url: identityUrl(),
    token: tokenResponse(),
    audience: '',
    id: 'netlify-user-42',
    email: 'someone@example.com',
    app_metadata: { provider: 'google' },
    user_metadata: {},
  }
}

let sessionMints = 0

/**
 * Answers the two endpoints a restore touches, and refuses everything else.
 *
 * An unexpected request is a failed test rather than a silent fallback: the
 * point of several of these is that a *particular* call did or did not happen.
 */
function stubNetwork(): void {
  sessionMints = 0
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.endsWith('/api/session') && method === 'POST') {
      sessionMints += 1
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: fakeJwt(HOUR), expires_in: HOUR }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    if (url === `${identityUrl()}/user`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: 'netlify-user-42', email: 'someone@example.com', app_metadata: {} }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    }

    if (url === `${identityUrl()}/logout`) {
      return Promise.resolve(new Response(null, { status: 204 }))
    }

    return Promise.reject(new Error(`Unexpected request in test: ${method} ${url}`))
  })
}

/**
 * Imports the store fresh, so its module-level env reads happen under the stubs.
 *
 * `resetModules` is what drops gotrue-js's own module-level cache of the current
 * user too — without it, a user recovered in one test is handed straight back in
 * the next, whatever localStorage says.
 */
async function loadStore() {
  vi.resetModules()
  return await import('./useAuthStore')
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', PROJECT_URL)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key-for-tests')
  vi.stubEnv('VITE_MOCK_PROVIDERS', '')

  // gotrue-js caches the recovered user in a module-level variable, and
  // `vi.resetModules()` cannot reach it: the package is externalised, so Node's
  // own module cache hands back the same instance every time. Without this, a
  // user recovered in one test is still signed in for the next one however
  // empty localStorage is.
  User.recoverSession()?.clearSession()

  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  stubNetwork()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('a configured build', () => {
  it('starts out checking rather than signed out, so a stored session is not flashed past', async () => {
    const { useAuthStore, requiresSignIn } = await loadStore()

    expect(requiresSignIn()).toBe(true)
    expect(useAuthStore.getState().status).toBe('checking')
  })

  it('restores the session left behind by a previous visit', async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(storedIdentitySession()))

    const { useAuthStore, isSignedIn } = await loadStore()
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(useAuthStore.getState().account).toEqual({
      id: 'netlify-user-42',
      email: 'someone@example.com',
    })
    expect(isSignedIn()).toBe(true)
  })

  it('mints the Supabase session up front, so a dead Identity session is caught here', async () => {
    // A refresh token that has run out looks exactly like a valid stored session
    // until something asks it for a token. Finding out at the gate beats finding
    // out on the first save.
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(storedIdentitySession()))

    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()

    expect(sessionMints).toBe(1)
  })

  it('asks for a sign-in when there is nothing stored', async () => {
    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(sessionMints).toBe(0)
  })

  it('does not treat unreadable stored data as a session', async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, '{not json')

    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
  })

  it('adopts the session Google redirected back with, and clears the address bar', async () => {
    const token = tokenResponse()
    window.history.replaceState(
      {},
      '',
      `/#access_token=${token.access_token}&refresh_token=${token.refresh_token}` +
        `&expires_in=${HOUR}&token_type=bearer`,
    )

    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-in')
    expect(useAuthStore.getState().account?.email).toBe('someone@example.com')

    // A token left in the fragment would be replayed by a reload, and would sit
    // in this tab's history in the meantime.
    expect(window.location.hash).toBe('')
    // Remembered, or the sign-in would not survive the next reload.
    expect(window.localStorage.getItem(IDENTITY_STORAGE_KEY)).toContain('netlify-user-42')
  })

  it('reports a refusal from Google rather than looking like nobody tried', async () => {
    window.history.replaceState({}, '', '/#error=access_denied&error_description=Nope')

    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().error).toContain('Nope')
  })

  it('clears the stored session on the way out', async () => {
    window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(storedIdentitySession()))

    const { useAuthStore } = await loadStore()
    await useAuthStore.getState().start()
    await useAuthStore.getState().signOut()

    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(useAuthStore.getState().account).toBeNull()
    expect(window.localStorage.getItem(IDENTITY_STORAGE_KEY)).toBeNull()
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
    await useAuthStore.getState().start()
    expect(useAuthStore.getState().status).toBe('local')
  })
})
