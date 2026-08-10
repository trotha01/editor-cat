import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireSession } from './auth'
import { resetForTests } from './auth0'

/**
 * What `/api/fal/*` will and will not spend the site's fal credits on.
 *
 * This used to check a token this repository also minted, so both halves of the
 * argument lived here and the test could sign one. It now checks the Auth0
 * access token the browser already holds, verified by auth0.ts against the
 * tenant's published keys — so these sign real RS256 tokens with a real key
 * pair and stub only the JWKS endpoint, exactly as auth0.test.ts does.
 *
 * The overlap with auth0.test.ts is deliberate rather than duplicated coverage.
 * That file proves the verifier is correct; this one proves `requireSession`
 * actually consults it and turns each answer into the right status code. A
 * version of this module that decoded the claims and skipped the signature would
 * pass every test in the other file.
 */
const DOMAIN = 'tenant.auth0.com'
const AUDIENCE = 'https://editor-cat/api'

const ENV_KEYS = [
  'AUTH0_DOMAIN',
  'AUTH0_AUDIENCE',
  'VITE_AUTH0_DOMAIN',
  'VITE_AUTH0_AUDIENCE',
  'FAL_PROXY_ALLOW_ANONYMOUS',
] as const

let saved: Record<string, string | undefined> = {}

let keyPair: CryptoKeyPair
let publicJwk: JsonWebKey

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Signs a token the way Auth0 would, so the real verifier sees the real thing. */
async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  signingKey: CryptoKey = keyPair.privateKey,
): Promise<string> {
  const encoded = `${base64Url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header }),
  )}.${base64Url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(encoded),
  )
  return `${encoded}.${base64Url(new Uint8Array(signature))}`
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'google-oauth2|104372',
    iss: `https://${DOMAIN}/`,
    aud: [AUDIENCE, `https://${DOMAIN}/userinfo`],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
}

function serveJwks(keys: unknown[] = [{ ...publicJwk, kid: 'key-1' }]) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }),
    ),
  )
}

function requestWith(token?: string): Request {
  return new Request('https://x.test/api/fal/some/model', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function newKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
}

beforeEach(async () => {
  // Vitest reuses worker processes, so environment changes have to be undone
  // or they leak into whatever file runs next.
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]

  // The module-level JWKS cache outlives a single test, which is the point of
  // it — but a key served in one test must not verify a token in the next.
  resetForTests()

  keyPair = await newKeyPair()
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  serveJwks()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
})

function configured() {
  process.env.AUTH0_DOMAIN = DOMAIN
  process.env.AUTH0_AUDIENCE = AUDIENCE
}

describe('requireSession', () => {
  it('accepts a token the tenant really signed, and reports whose it is', async () => {
    configured()

    const result = await requireSession(requestWith(await sign(validClaims())))

    expect(result.ok).toBe(true)
    // The Auth0 subject, which is what every row is filed under now — and not a
    // UUID, which is the whole subject of migration 0006.
    if (result.ok) expect(result.userId).toBe('google-oauth2|104372')
  })

  it('fails closed when the deployment is not configured at all', async () => {
    // The dangerous default would be to run open: this endpoint spends money.
    const result = await requireSession(requestWith(await sign(validClaims())))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(503)
  })

  it('takes the build-time tenant settings, which name the same tenant', async () => {
    process.env.VITE_AUTH0_DOMAIN = DOMAIN
    process.env.VITE_AUTH0_AUDIENCE = AUDIENCE

    expect((await requireSession(requestWith(await sign(validClaims())))).ok).toBe(true)
  })

  it('allows anonymous access only when explicitly opted in', async () => {
    process.env.FAL_PROXY_ALLOW_ANONYMOUS = '1'
    const result = await requireSession(requestWith())

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.userId).toBeNull()
  })

  it('rejects a request with no token, or one that is not a bearer', async () => {
    configured()

    expect((await requireSession(requestWith())).ok).toBe(false)

    const basic = new Request('https://x.test/api/fal/m', {
      headers: { authorization: 'Basic abc' },
    })
    const result = await requireSession(basic)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    configured()

    const stale = await sign(validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }))
    const result = await requireSession(requestWith(stale))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects a token signed by someone else, however well-formed its claims', async () => {
    // The whole point of the exercise: correct claims and the wrong key is
    // exactly what an attacker can produce.
    configured()

    const forged = await sign(validClaims(), {}, (await newKeyPair()).privateKey)
    const result = await requireSession(requestWith(forged))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects an unsigned token', async () => {
    // `alg: none` is the oldest trick there is, and it only works on a verifier
    // that reads the algorithm out of the header instead of asserting it.
    configured()

    const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const payload = base64Url(JSON.stringify(validClaims()))
    const unsigned = `${header}.${payload}.`

    expect((await requireSession(requestWith(unsigned))).ok).toBe(false)
  })

  it('rejects a token minted for a different audience', async () => {
    // An access token for another API of the same tenant is signed by the same
    // key and would otherwise sail through — and this is the check that makes
    // the ID token, whose `aud` is the SPA's client id, unusable here.
    configured()

    const other = await sign(validClaims({ aud: 'https://someone-elses/api' }))
    const result = await requireSession(requestWith(other))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('rejects a token from another tenant', async () => {
    configured()

    const foreign = await sign(validClaims({ iss: 'https://other.auth0.com/' }))
    expect((await requireSession(requestWith(foreign))).ok).toBe(false)
  })

  it('says the tenant is unreachable rather than that the token is bad', async () => {
    // Merging the two would tell someone to sign in again during an outage that
    // signing in again cannot fix.
    configured()
    const token = await sign(validClaims())
    resetForTests()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))

    const result = await requireSession(requestWith(token))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(502)
  })

  it('verifies without a round trip per request, which a polling job depends on', async () => {
    // One video generation polls for minutes. A fetch per poll would be slow
    // here and rude to a tenant that is not being paid to answer them, so the
    // JWKS cache in auth0.ts is load-bearing rather than an optimisation.
    configured()

    let fetches = 0
    vi.stubGlobal('fetch', () => {
      fetches += 1
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'key-1' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    })

    for (let i = 0; i < 5; i += 1) {
      expect((await requireSession(requestWith(await sign(validClaims())))).ok).toBe(true)
    }

    expect(fetches).toBe(1)
  })
})
