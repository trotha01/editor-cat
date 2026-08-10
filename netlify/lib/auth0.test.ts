import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_CLAIM, auth0Config, auth0User, pickJwk, resetForTests } from './auth0'

/**
 * Verifying an Auth0 token without asking Auth0.
 *
 * Netlify Identity had to be asked — its tokens were signed with a secret this
 * side never saw — so `/api/session` paid a round trip per mint. Auth0 signs with
 * RS256 and publishes the public half, which removes the round trip and puts the
 * whole of the check here instead. That makes this the one place where getting it
 * wrong is silent: a verifier that skips the audience, or trusts the algorithm
 * named in the header, accepts tokens it should not and nothing else notices.
 *
 * So these sign real JWTs with a real key and put them through the real
 * verifier. Only the JWKS fetch is faked.
 */

const DOMAIN = 'tenant.auth0.com'
const CONFIG = { domain: DOMAIN, audience: 'https://editor-cat/api' }

let keyPair: CryptoKeyPair
let publicJwk: JsonWebKey

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Signs a token the way Auth0 would, so the verifier sees the real thing. */
async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encoded = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header }))}.${base64Url(
    JSON.stringify(claims),
  )}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(encoded),
  )
  return `${encoded}.${base64Url(new Uint8Array(signature))}`
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'auth0|42',
    iss: `https://${DOMAIN}/`,
    aud: [CONFIG.audience, `https://${DOMAIN}/userinfo`],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
}

/** Answers the JWKS endpoint with the public half, and counts the fetches. */
let jwksFetches = 0

function serveJwks(keys: unknown[] = [{ ...publicJwk, kid: 'key-1' }]) {
  jwksFetches = 0
  vi.stubGlobal('fetch', () => {
    jwksFetches += 1
    return Promise.resolve(
      new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } }),
    )
  })
}

beforeEach(async () => {
  resetForTests()
  keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  serveJwks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth0Config', () => {
  const KEYS = ['AUTH0_DOMAIN', 'VITE_AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'VITE_AUTH0_AUDIENCE']
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    for (const key of KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('needs both halves, and strips a scheme an operator reasonably pasted', () => {
    process.env.AUTH0_DOMAIN = 'https://tenant.auth0.com/'
    expect(auth0Config()).toBeNull()

    process.env.AUTH0_AUDIENCE = 'https://editor-cat/api'
    expect(auth0Config()).toEqual(CONFIG)
  })

  it('falls back to the build-time pair, which is the same tenant', () => {
    process.env.VITE_AUTH0_DOMAIN = DOMAIN
    process.env.VITE_AUTH0_AUDIENCE = 'https://editor-cat/api'
    expect(auth0Config()).toEqual(CONFIG)
  })
})

describe('auth0User', () => {
  it('accepts a token Auth0 really signed', async () => {
    await expect(auth0User(await sign(validClaims()), CONFIG)).resolves.toEqual({
      id: 'auth0|42',
      email: '',
    })
  })

  it('reads the address out of the namespaced claim when a tenant adds one', async () => {
    const token = await sign(validClaims({ [EMAIL_CLAIM]: 'someone@example.com' }))
    await expect(auth0User(token, CONFIG)).resolves.toEqual({
      id: 'auth0|42',
      email: 'someone@example.com',
    })
  })

  it('refuses a token signed by someone else', async () => {
    // The whole point of the exercise: a well-formed token with correct claims
    // and the wrong key is exactly what an attacker can produce.
    const other = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    serveJwks([{ ...(await crypto.subtle.exportKey('jwk', other.publicKey)), kid: 'key-1' }])

    await expect(auth0User(await sign(validClaims()), CONFIG)).resolves.toBeNull()
  })

  it('refuses a token that names an algorithm of its own choosing', async () => {
    // `alg: none` and HMAC-with-the-public-key are both reached by trusting the
    // header, which is why the algorithm is asserted rather than read.
    await expect(auth0User(await sign(validClaims(), { alg: 'none' }), CONFIG)).resolves.toBeNull()
    await expect(auth0User(await sign(validClaims(), { alg: 'HS256' }), CONFIG)).resolves.toBeNull()
  })

  it('refuses a token minted for a different audience', async () => {
    // An access token for some other API of the same tenant is signed by the
    // same key and would otherwise sail through.
    const token = await sign(validClaims({ aud: 'https://someone-elses/api' }))
    await expect(auth0User(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses a token from another tenant', async () => {
    const token = await sign(validClaims({ iss: 'https://other.auth0.com/' }))
    await expect(auth0User(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses an expired token, and one that never says', async () => {
    // An unbounded session is not something to accept by omission.
    const expired = await sign(validClaims({ exp: Math.floor(Date.now() / 1000) - 1 }))
    await expect(auth0User(expired, CONFIG)).resolves.toBeNull()

    const claims = validClaims()
    delete claims.exp
    await expect(auth0User(await sign(claims), CONFIG)).resolves.toBeNull()
  })

  it('refuses a token with no subject', async () => {
    // That id is the key everything this app stores is filed under, and a row
    // keyed on `undefined` is worse than a refused sign-in.
    const claims = validClaims()
    delete claims.sub
    await expect(auth0User(await sign(claims), CONFIG)).resolves.toBeNull()
  })

  it('refuses something that is not a JWT at all', async () => {
    await expect(auth0User('not.a.jwt', CONFIG)).resolves.toBeNull()
    await expect(auth0User('nonsense', CONFIG)).resolves.toBeNull()
  })

  it('caches the signing keys rather than fetching them per request', async () => {
    await auth0User(await sign(validClaims()), CONFIG)
    await auth0User(await sign(validClaims()), CONFIG)

    expect(jwksFetches).toBe(1)
  })

  it('refetches once for a key it has not seen, so a rotation needs no deploy', async () => {
    await auth0User(await sign(validClaims()), CONFIG)

    const token = await sign(validClaims(), { kid: 'key-2' })
    serveJwks([{ ...publicJwk, kid: 'key-2' }])
    await expect(auth0User(token, CONFIG)).resolves.toMatchObject({ id: 'auth0|42' })
  })

  it('will not refetch again straight away for another key it has not seen', async () => {
    // The refetch above is triggered by a `kid` read out of an unverified
    // header, on a request that need not carry a usable token at all — and
    // `/api/fal/*` is reachable by anyone with the URL. Ungoverned, a loop of
    // tokens naming random key ids is a loop of requests to Auth0's JWKS
    // endpoint; it answers 429, this module starts raising, and the people with
    // real tokens get 502s. So the second unknown id inside the window is
    // answered from cache and simply refused.
    await auth0User(await sign(validClaims()), CONFIG)
    jwksFetches = 0

    for (const kid of ['nope-1', 'nope-2', 'nope-3', 'nope-4']) {
      await expect(auth0User(await sign(validClaims(), { kid }), CONFIG)).resolves.toBeNull()
    }

    expect(jwksFetches).toBe(1)
  })

  it('refuses a token whose signature is not base64url, rather than raising', async () => {
    // A throw would leave here as "the tenant could not be reached" and answer
    // 502, telling someone to wait out an outage over a token that is merely
    // malformed. It must not reach the JWKS endpoint either.
    jwksFetches = 0
    const [header, payload] = (await sign(validClaims())).split('.')

    await expect(auth0User(`${header}.${payload}.@@@@`, CONFIG)).resolves.toBeNull()
    expect(jwksFetches).toBe(0)
  })

  it('says the tenant is unreachable rather than that the token is bad', async () => {
    // Merging the two would tell someone to sign in again during an outage that
    // signing in again cannot fix.
    resetForTests()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))

    await expect(auth0User(await sign(validClaims()), CONFIG)).rejects.toThrow(/Could not reach/)
  })
})

describe('pickJwk', () => {
  it('finds the key by id, and takes a lone key when none is named', () => {
    const keys = [
      { kty: 'RSA', n: 'a', e: 'AQAB', kid: 'one' },
      { kty: 'RSA', n: 'b', e: 'AQAB', kid: 'two' },
    ]
    expect(pickJwk({ keys }, 'two')).toEqual(keys[1])
    expect(pickJwk({ keys: [keys[0]!] }, null)).toEqual(keys[0])
    // Ambiguous, so refused rather than guessed.
    expect(pickJwk({ keys }, null)).toBeNull()
    expect(pickJwk({ keys }, 'three')).toBeNull()
    expect(pickJwk({}, 'one')).toBeNull()
  })
})
