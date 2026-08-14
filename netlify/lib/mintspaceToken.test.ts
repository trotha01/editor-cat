import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type MintspaceConfig,
  mintspaceConfig,
  mintspaceUser,
  pickJwk,
  resetForTests,
} from './mintspaceToken'

const URL_BASE = 'https://mintspace.supabase.co'
const CONFIG: MintspaceConfig = { url: URL_BASE, jwtSecret: null }

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeSegment(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)))
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: `${URL_BASE}/auth/v1`,
    aud: 'authenticated',
    sub: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    role: 'authenticated',
    exp: FUTURE,
    ...overrides,
  }
}

/** A real ES256 key pair, so the tests exercise the actual verify path. */
async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, jwk: { ...jwk, kid: 'test-key', alg: 'ES256' } }
}

async function signEs256(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'ES256', kid: 'test-key', typ: 'JWT' },
): Promise<string> {
  const signed = `${encodeSegment(header)}.${encodeSegment(payload)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signed) as unknown as ArrayBuffer,
  )
  return `${signed}.${b64url(new Uint8Array(signature))}`
}

async function signHs256(secret: string, payload: Record<string, unknown>): Promise<string> {
  const signed = `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signed) as unknown as ArrayBuffer,
  )
  return `${signed}.${b64url(new Uint8Array(signature))}`
}

function serveJwks(jwk: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
  )
}

describe('mintspaceConfig', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.MINTSPACE_SUPABASE_URL
    delete process.env.VITE_MINTSPACE_SUPABASE_URL
    delete process.env.MINTSPACE_SUPABASE_JWT_SECRET
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('is null when there is no Mintspace behind this deployment', () => {
    expect(mintspaceConfig()).toBeNull()
  })

  it('falls back to the VITE_ form, which names the same project', () => {
    process.env.VITE_MINTSPACE_SUPABASE_URL = `${URL_BASE}/`
    expect(mintspaceConfig()).toEqual({ url: URL_BASE, jwtSecret: null })
  })

  it('prefers the unprefixed form and trims the trailing slash', () => {
    process.env.MINTSPACE_SUPABASE_URL = `${URL_BASE}//`
    process.env.VITE_MINTSPACE_SUPABASE_URL = 'https://wrong.supabase.co'
    expect(mintspaceConfig()?.url).toBe(URL_BASE)
  })
})

describe('pickJwk', () => {
  it('matches on kid', () => {
    const keys = { keys: [{ kid: 'a' }, { kid: 'b' }] }
    expect(pickJwk(keys, 'b')).toEqual({ kid: 'b' })
    expect(pickJwk(keys, 'c')).toBeNull()
  })

  it('takes the only key when a token names none', () => {
    expect(pickJwk({ keys: [{ kid: 'a' }] }, null)).toEqual({ kid: 'a' })
  })

  it('refuses to guess between several', () => {
    expect(pickJwk({ keys: [{ kid: 'a' }, { kid: 'b' }] }, null)).toBeNull()
  })
})

describe('mintspaceUser', () => {
  beforeEach(() => {
    resetForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetForTests()
  })

  it('returns the uid from a properly signed token', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(pair.privateKey, claims())
    await expect(mintspaceUser(token, CONFIG)).resolves.toEqual({
      id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    })
  })

  it('refuses a token signed by somebody else', async () => {
    const { jwk } = await keyPair()
    const other = await keyPair()
    serveJwks(jwk)

    // Signed with a key the project does not publish — the whole point of
    // verifying rather than decoding.
    const token = await signEs256(other.pair.privateKey, claims())
    await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses a tampered payload', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(pair.privateKey, claims())
    const [header, , signature] = token.split('.')
    const swapped = encodeSegment(claims({ sub: 'someone-elses-uid' }))
    await expect(mintspaceUser(`${header}.${swapped}.${signature}`, CONFIG)).resolves.toBeNull()
  })

  it('refuses alg:none and other unsigned shapes', async () => {
    const { jwk } = await keyPair()
    serveJwks(jwk)

    const unsigned = `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(claims())}.`
    await expect(mintspaceUser(unsigned, CONFIG)).resolves.toBeNull()
    await expect(mintspaceUser('not-a-jwt', CONFIG)).resolves.toBeNull()
  })

  it('refuses a token from another Supabase project', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(
      pair.privateKey,
      claims({ iss: 'https://other.supabase.co/auth/v1' }),
    )
    await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses an expired session', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(
      pair.privateKey,
      claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
    )
    await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses the anon key, which is also a JWT from this project', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    // The one that would actually be tried: the anon key is public, sits in
    // every browser bundle, and carries no `sub`. Treating it as a person would
    // give everyone the same prefix.
    const token = await signEs256(pair.privateKey, {
      iss: `${URL_BASE}/auth/v1`,
      aud: 'anon',
      role: 'anon',
      exp: FUTURE,
    })
    await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
  })

  it('refuses a session with no subject', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(pair.privateKey, claims({ sub: undefined }))
    await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
  })

  it('caches the key set rather than fetching per request', async () => {
    const { pair, jwk } = await keyPair()
    serveJwks(jwk)

    const token = await signEs256(pair.privateKey, claims())
    await mintspaceUser(token, CONFIG)
    await mintspaceUser(token, CONFIG)
    await mintspaceUser(token, CONFIG)

    // A round trip per request to somebody else's auth server would be both
    // slow and rude; publishing signs a URL per segment.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('refetches once when a token names a key it has not seen', async () => {
    const first = await keyPair()
    const rotated = await keyPair()
    const rotatedJwk = { ...rotated.jwk, kid: 'rotated' }

    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return new Response(JSON.stringify({ keys: [call === 1 ? first.jwk : rotatedJwk] }), {
          status: 200,
        })
      }),
    )

    const token = await signEs256(rotated.pair.privateKey, claims(), {
      alg: 'ES256',
      kid: 'rotated',
      typ: 'JWT',
    })
    await expect(mintspaceUser(token, CONFIG)).resolves.toEqual({
      id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    })
    expect(call).toBe(2)
  })

  describe('legacy HS256 projects', () => {
    it('verifies against the configured secret', async () => {
      const token = await signHs256('shhh', claims())
      await expect(mintspaceUser(token, { url: URL_BASE, jwtSecret: 'shhh' })).resolves.toEqual({
        id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      })
    })

    it('refuses the wrong secret', async () => {
      const token = await signHs256('shhh', claims())
      await expect(mintspaceUser(token, { url: URL_BASE, jwtSecret: 'other' })).resolves.toBeNull()
    })

    it('refuses HS256 outright when no secret is configured', async () => {
      // Never fall through to the JWKS path for an HMAC token: that is the
      // classic confusion where a public key gets used as a shared secret.
      const token = await signHs256('shhh', claims())
      await expect(mintspaceUser(token, CONFIG)).resolves.toBeNull()
    })
  })
})
