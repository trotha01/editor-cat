import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireSession } from './auth'
import {
  SESSION_ISSUER,
  SESSION_LIFETIME_SECONDS,
  mintSessionToken,
  sessionClaims,
  supabaseJwtSecret,
} from './supabaseToken'

/**
 * The token that stands in for a Supabase session.
 *
 * Two audiences have to accept it and neither is here to be asked: Postgres,
 * which switches roles on `role` and resolves `auth.uid()` from `sub`, and this
 * site's own functions. The second half is testable directly — a minted token
 * and `requireSession` are both in this repository — and it is the half that
 * would fail silently, because a token nobody accepts looks exactly like a user
 * who is not signed in.
 */
const SECRET = 'a-shared-signing-secret'
const USER = { id: '3f1c9b52-9a1e-4d55-9e10-8f2b6c1a0d77', email: 'someone@example.com' }

const ENV_KEYS = ['SUPABASE_JWT_SECRET', 'FAL_PROXY_ALLOW_ANONYMOUS'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
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

function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
}

describe('sessionClaims', () => {
  it('files the session under the Netlify Identity user id', () => {
    // `auth.uid()` reads exactly this, and every `user_id` column is compared
    // against it. Put anything else here and row-level security starts hiding
    // people's own projects from them.
    expect(sessionClaims(USER, 1_700_000_000).sub).toBe(USER.id)
  })

  it('claims the authenticated role, which is what the RLS policies are written against', () => {
    // PostgREST switches to the role named here. Without it the request reads
    // the tables as `anon`, which the policies refuse outright.
    const claims = sessionClaims(USER, 1_700_000_000)

    expect(claims.role).toBe('authenticated')
    expect(claims.aud).toBe('authenticated')
  })

  it('expires, and says who issued it', () => {
    const claims = sessionClaims(USER, 1_700_000_000)

    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_000_000 + SESSION_LIFETIME_SECONDS)
    // Not the Supabase project URL: the project did not issue this, and a claim
    // that says otherwise is one more untrue thing in a log.
    expect(claims.iss).toBe(SESSION_ISSUER)
  })
})

describe('mintSessionToken', () => {
  it('produces a token this site’s own functions accept', async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET

    const token = await mintSessionToken(USER, SECRET)
    const result = await requireSession(
      new Request('https://x.test/api/fal/m', { headers: { authorization: `Bearer ${token}` } }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBe(USER.id)
  })

  it('is refused by a site holding a different secret', async () => {
    // Which is what stops one deployment's sessions from being spent on
    // another's fal credits.
    process.env.SUPABASE_JWT_SECRET = 'a-completely-different-secret'

    const token = await mintSessionToken(USER, SECRET)
    const result = await requireSession(
      new Request('https://x.test/api/fal/m', { headers: { authorization: `Bearer ${token}` } }),
    )

    expect(result.ok).toBe(false)
  })

  it('is refused once it has expired', async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET

    const longAgo = Math.floor(Date.now() / 1000) - SESSION_LIFETIME_SECONDS - 600
    const token = await mintSessionToken(USER, SECRET, longAgo)
    const result = await requireSession(
      new Request('https://x.test/api/fal/m', { headers: { authorization: `Bearer ${token}` } }),
    )

    expect(result.ok).toBe(false)
  })

  it('signs with HS256, which is the one algorithm the verifier will take', async () => {
    const token = await mintSessionToken(USER, SECRET)
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>

    expect(header.alg).toBe('HS256')
  })

  it('mints for an address that is not plain ASCII', async () => {
    // `btoa` refuses anything outside Latin-1, so a payload encoded as
    // characters rather than UTF-8 bytes throws here — and only for the one
    // account whose address has an accent in it.
    process.env.SUPABASE_JWT_SECRET = SECRET

    const user = { id: USER.id, email: 'zoë@example.com' }
    const token = await mintSessionToken(user, SECRET)

    expect(claimsOf(token).email).toBe('zoë@example.com')
    expect(
      (
        await requireSession(
          new Request('https://x.test/api/fal/m', {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      ).ok,
    ).toBe(true)
  })

  it('carries the address, and no credential of any kind', async () => {
    const claims = claimsOf(await mintSessionToken(USER, SECRET))

    expect(claims.email).toBe(USER.email)
    // The Identity token that bought this session stays on the server side of
    // the exchange. Nothing about it belongs in a token the browser holds.
    expect(JSON.stringify(claims)).not.toContain(SECRET)
  })
})

describe('supabaseJwtSecret', () => {
  it('never falls back to a VITE_ variable', () => {
    // Every other Supabase value this site reads has such a fallback because it
    // is public. A `VITE_` prefix on this one would inline the signing secret
    // into the bundle and let any visitor mint a session as anybody.
    process.env.VITE_SUPABASE_JWT_SECRET = 'inlined-into-the-bundle'
    try {
      expect(supabaseJwtSecret()).toBe('')
    } finally {
      delete process.env.VITE_SUPABASE_JWT_SECRET
    }
  })
})
