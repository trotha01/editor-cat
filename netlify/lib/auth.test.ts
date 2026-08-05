import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeJwt, isExpired, pickJwk, requireSession, resetJwksCacheForTests } from './auth'

const SECRET = 'a-shared-signing-secret'
const PROJECT = 'https://abcdefgh.supabase.co'

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_JWT_SECRET', 'FAL_PROXY_ALLOW_ANONYMOUS'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  // Vitest reuses worker processes, so environment changes have to be undone
  // or they leak into whatever file runs next.
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  resetJwksCacheForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const b64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')

async function signHs256(claims: Record<string, unknown>, secret = SECRET): Promise<string> {
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${b64url(new Uint8Array(signature))}`
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-123',
    iss: `${PROJECT}/auth/v1`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
}

function requestWith(token?: string): Request {
  return new Request('https://x.test/api/fal/some/model', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('decodeJwt', () => {
  it('reads the header and claims without trusting them yet', async () => {
    const token = await signHs256(validClaims())
    const jwt = decodeJwt(token)

    expect(jwt?.alg).toBe('HS256')
    expect(jwt?.claims.sub).toBe('user-123')
    expect(jwt?.claims.iss).toBe(`${PROJECT}/auth/v1`)
  })

  it('refuses anything that is not three readable segments', () => {
    expect(decodeJwt('')).toBeNull()
    expect(decodeJwt('one.two')).toBeNull()
    expect(decodeJwt('a.b.c.d')).toBeNull()
    expect(decodeJwt('not!base64.at!all.nope')).toBeNull()
    expect(decodeJwt(`${b64url('{"typ":"JWT"}')}.${b64url('{}')}.sig`)).toBeNull()
  })
})

describe('isExpired', () => {
  it('allows a minute of clock skew between Supabase and the function host', () => {
    expect(isExpired({ exp: 1000 }, 1030)).toBe(false)
    expect(isExpired({ exp: 1000 }, 1100)).toBe(true)
  })

  it('treats a token with no expiry as expired', () => {
    // An unbounded session is not something to accept by omission.
    expect(isExpired({}, 1000)).toBe(true)
  })
})

describe('pickJwk', () => {
  it('matches on kid, and accepts a lone key that names none', () => {
    // `kid` is not part of TypeScript's JsonWebKey, though every real key set
    // carries it — which is why pickJwk has to reach for it the same way.
    const keys = [{ kid: 'a' }, { kid: 'b' }] as unknown as JsonWebKey[]
    expect(pickJwk({ keys }, 'b')).toBe(keys[1])
    expect(pickJwk({ keys }, 'missing')).toBeNull()
    expect(pickJwk({ keys: [keys[0]!] }, null)).toBe(keys[0])
  })

  it('refuses to guess between several unnamed keys', () => {
    expect(pickJwk({ keys: [{}, {}] as JsonWebKey[] }, null)).toBeNull()
    expect(pickJwk({}, null)).toBeNull()
  })
})

describe('requireSession', () => {
  it('accepts a session signed with the project secret', async () => {
    process.env.SUPABASE_URL = PROJECT
    process.env.SUPABASE_JWT_SECRET = SECRET

    const result = await requireSession(requestWith(await signHs256(validClaims())))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBe('user-123')
  })

  it('fails closed when the deployment is not configured at all', async () => {
    // The dangerous default would be to run open: this endpoint spends money.
    const result = await requireSession(requestWith(await signHs256(validClaims())))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(503)
  })

  it('allows anonymous access only when explicitly opted in', async () => {
    process.env.FAL_PROXY_ALLOW_ANONYMOUS = '1'
    const result = await requireSession(requestWith())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBeNull()
  })

  it('rejects a request with no token, or one that is not a bearer', async () => {
    process.env.SUPABASE_URL = PROJECT
    process.env.SUPABASE_JWT_SECRET = SECRET

    expect((await requireSession(requestWith())).ok).toBe(false)

    const basic = new Request('https://x.test/api/fal/m', {
      headers: { authorization: 'Basic abc' },
    })
    const result = await requireSession(basic)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects an expired session', async () => {
    process.env.SUPABASE_URL = PROJECT
    process.env.SUPABASE_JWT_SECRET = SECRET

    const stale = await signHs256(validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))
    expect((await requireSession(requestWith(stale))).ok).toBe(false)
  })

  it('rejects a session issued by a different Supabase project', async () => {
    process.env.SUPABASE_URL = PROJECT
    process.env.SUPABASE_JWT_SECRET = SECRET

    const foreign = await signHs256(
      validClaims({ iss: 'https://someone-else.supabase.co/auth/v1' }),
    )
    expect((await requireSession(requestWith(foreign))).ok).toBe(false)
  })

  it('rejects a token signed with the wrong secret', async () => {
    // The whole point: readable claims are not the same as a verified session.
    process.env.SUPABASE_URL = PROJECT
    process.env.SUPABASE_JWT_SECRET = SECRET

    const forged = await signHs256(validClaims(), 'not-the-real-secret')
    const result = await requireSession(requestWith(forged))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects an HS256 token when only asymmetric verification is configured', async () => {
    // Otherwise "alg" would be attacker-controlled: anyone could downgrade to a
    // secret we never set and have it accepted.
    process.env.SUPABASE_URL = PROJECT

    const result = await requireSession(requestWith(await signHs256(validClaims())))
    expect(result.ok).toBe(false)
  })
})
