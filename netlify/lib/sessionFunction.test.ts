import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The seam between the two identity systems: `netlify/functions/session.ts`.
 *
 * Lives here rather than beside the handler because Netlify turns every file in
 * the functions directory into a deployable endpoint — see functionNames.test.ts.
 *
 * Identity itself is mocked out; identity.test.ts covers talking to it. What is
 * worth pinning down here is what the handler does with each answer, because
 * every one of them is a different thing to tell the browser: sign in again,
 * try again later, or "this site was never finished".
 */
const identityUser = vi.fn()

class FakeIdentityUnavailableError extends Error {}

vi.mock('./identity', () => ({
  identityUser: (token: string, requestUrl: string) => identityUser(token, requestUrl) as unknown,
  IdentityUnavailableError: FakeIdentityUnavailableError,
}))

const handler = (await import('../functions/session')).default

const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'SUPABASE_URL', 'VITE_SUPABASE_URL'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]

  process.env.SUPABASE_JWT_SECRET = 'a-shared-signing-secret'
  process.env.SUPABASE_URL = 'https://abcdefgh.supabase.co'
  identityUser.mockResolvedValue({ id: 'user-uuid', email: 'someone@example.com' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

function post(token?: string): Request {
  return new Request('https://site.example/api/session', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('GET /api/session', () => {
  it('says the site is ready without being shown a token', async () => {
    // The sign-in screen asks this before a session exists, which is precisely
    // the moment it has nothing to present.
    const response = await handler(new Request('https://site.example/api/session'))

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ready: true })
  })

  it('says it is not ready when the signing secret is missing', async () => {
    delete process.env.SUPABASE_JWT_SECRET

    const response = await handler(new Request('https://site.example/api/session'))

    expect(await body(response)).toEqual({ ready: false, problem: 'not-configured' })
  })

  it('names the missing variable in the log, and nowhere else', async () => {
    delete process.env.SUPABASE_JWT_SECRET

    const response = await handler(new Request('https://site.example/api/session'))

    // Naming environment variables to anonymous callers tells them nothing they
    // can act on and something about how the site is built.
    expect(JSON.stringify(await body(response))).not.toContain('SUPABASE_JWT_SECRET')
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('SUPABASE_JWT_SECRET')
  })
})

describe('POST /api/session', () => {
  it('mints a session for a token Identity accepts', async () => {
    const response = await handler(post('identity-token'))

    expect(response.status).toBe(200)
    const minted = await body(response)
    expect(typeof minted.access_token).toBe('string')
    expect(minted.expires_in).toBe(3600)
    expect(minted.user).toEqual({ id: 'user-uuid', email: 'someone@example.com' })

    expect(identityUser).toHaveBeenCalledWith('identity-token', 'https://site.example/api/session')
  })

  it('never lets the minted token be cached between here and the browser', async () => {
    const response = await handler(post('identity-token'))

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a request with no token', async () => {
    const response = await handler(post())

    expect(response.status).toBe(401)
    expect(identityUser).not.toHaveBeenCalled()
  })

  it('refuses a token Identity does not accept', async () => {
    identityUser.mockResolvedValue(null)

    expect((await handler(post('stale-token'))).status).toBe(401)
  })

  it('answers 502 rather than 401 when Identity could not be asked', async () => {
    // The difference is what the browser tells the user to do. A 401 sends
    // someone to sign in again, which during an Identity outage is the one
    // thing guaranteed not to work.
    identityUser.mockRejectedValue(new FakeIdentityUnavailableError('nothing answered'))

    expect((await handler(post('identity-token'))).status).toBe(502)
  })

  it('answers 503 when the site cannot sign a session at all', async () => {
    // An operator mistake, not the visitor's, and checked before the Identity
    // round trip so a misconfigured site does not lean on Netlify to find out.
    delete process.env.SUPABASE_JWT_SECRET

    const response = await handler(post('identity-token'))

    expect(response.status).toBe(503)
    expect(identityUser).not.toHaveBeenCalled()
  })

  it('answers 503 when no Supabase project is named', async () => {
    delete process.env.SUPABASE_URL

    expect((await handler(post('identity-token'))).status).toBe(503)
  })

  it('counts a project named only by the build-time variable as configured', async () => {
    // Operators set VITE_SUPABASE_URL because the browser bundle needs it, and
    // it is the same public string.
    delete process.env.SUPABASE_URL
    process.env.VITE_SUPABASE_URL = 'https://abcdefgh.supabase.co'

    expect((await handler(post('identity-token'))).status).toBe(200)
  })

  it('refuses any other method', async () => {
    const response = await handler(
      new Request('https://site.example/api/session', { method: 'DELETE' }),
    )

    expect(response.status).toBe(405)
  })
})
