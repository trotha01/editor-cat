import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeJwt, isExpired, requireSession } from './auth'
import { SESSION_ISSUER } from './supabaseToken'

const SECRET = 'a-shared-signing-secret'

const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'FAL_PROXY_ALLOW_ANONYMOUS'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  // Vitest reuses worker processes, so environment changes have to be undone
  // or they leak into whatever file runs next.
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
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
    iss: SESSION_ISSUER,
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
    expect(jwt?.claims.iss).toBe(SESSION_ISSUER)
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
  it('allows a minute of clock skew between the minting host and this one', () => {
    expect(isExpired({ exp: 1000 }, 1030)).toBe(false)
    expect(isExpired({ exp: 1000 }, 1100)).toBe(true)
  })

  it('treats a token with no expiry as expired', () => {
    // An unbounded session is not something to accept by omission.
    expect(isExpired({}, 1000)).toBe(true)
  })
})

describe('requireSession', () => {
  it('accepts a session this site minted', async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET

    const result = await requireSession(requestWith(await signHs256(validClaims())))

    expect(result.ok).toBe(true)
    // The Netlify Identity user id, which is what every row is filed under.
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
    process.env.SUPABASE_JWT_SECRET = SECRET

    const stale = await signHs256(validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))
    expect((await requireSession(requestWith(stale))).ok).toBe(false)
  })

  it('rejects a token this site did not issue, however well signed', async () => {
    // The signing secret is the Supabase project's, so a token Supabase itself
    // minted carries a valid signature. It is still not one of ours, and the
    // issuer is the only thing that says so.
    process.env.SUPABASE_JWT_SECRET = SECRET

    const foreign = await signHs256(validClaims({ iss: 'https://abcdefgh.supabase.co/auth/v1' }))
    const result = await requireSession(requestWith(foreign))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects a token signed with the wrong secret', async () => {
    // The whole point: readable claims are not the same as a verified session.
    process.env.SUPABASE_JWT_SECRET = SECRET

    const forged = await signHs256(validClaims(), 'not-the-real-secret')
    const result = await requireSession(requestWith(forged))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects any algorithm but the one it verifies', async () => {
    // Otherwise `alg` would be attacker-controlled: "none", or a family this
    // module does not check, would sail straight through.
    process.env.SUPABASE_JWT_SECRET = SECRET

    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const payload = b64url(JSON.stringify(validClaims()))
    const unsigned = `${header}.${payload}.${b64url('')}`

    expect((await requireSession(requestWith(unsigned))).ok).toBe(false)
  })
})
