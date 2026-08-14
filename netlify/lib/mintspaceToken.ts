/**
 * Verifying a Mintspace session, so a feed upload lands under the right account.
 *
 * This app has two identities and they are not interchangeable — see
 * src/lib/mintspace/client.ts, which explains at length why publishing needs a
 * Supabase Auth account of its own rather than the Auth0 one the editor runs
 * under. That split is fine everywhere else, and it is a problem in exactly one
 * place: deciding which R2 prefix a published video's objects belong to.
 *
 * Key them by the Auth0 subject and one Mintspace account reached from two
 * Auth0 sign-ins scatters its videos across two prefixes. The delete path then
 * passes its Mintspace check, removes the row, derives the *other* prefix, finds
 * nothing, and reports success over a set of files nobody can reach again.
 * Today that is impossible because one session authorises both the row and the
 * object; keying by the Mintspace uid is what keeps it impossible.
 *
 * So the upload endpoint asks for both tokens: Auth0 to prove you may spend this
 * deployment's resources at all, and this one to say whose shelf it goes on.
 *
 * Verified locally against the project's published keys, for the same reason
 * auth0.ts does it: a round trip per request to somebody else's auth server is
 * slow and rude, and the cache below makes the check arithmetic over bytes
 * already in hand.
 */

export interface MintspaceConfig {
  /** The project's base URL, without a trailing slash. */
  url: string
  /** Set only on legacy projects that still sign with a shared secret. */
  jwtSecret: string | null
}

export interface MintspaceUser {
  /** `sub` — a uuid, and what `auth.uid()` returns inside Mintspace's RLS. */
  id: string
}

export class MintspaceUnavailableError extends Error {}

/**
 * Where Mintspace lives, or null when this deployment has no Mintspace behind
 * it.
 *
 * `MINTSPACE_SUPABASE_URL` falls back to its `VITE_` form, the same way
 * `AUTH0_DOMAIN` does in auth0.ts and for the same reason: a project URL is in
 * every request the browser makes and is not a secret. The JWT secret has no
 * `VITE_` fallback and never may — that one really is a credential, and one that
 * can mint a session as anybody.
 */
export function mintspaceConfig(): MintspaceConfig | null {
  const url = (process.env.MINTSPACE_SUPABASE_URL ?? process.env.VITE_MINTSPACE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) return null

  const jwtSecret = (process.env.MINTSPACE_SUPABASE_JWT_SECRET ?? '').trim()
  return { url, jwtSecret: jwtSecret || null }
}

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}

interface Jwks {
  keys: Jwk[]
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function decodeSegment(segment: string): unknown {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface CachedJwks {
  keys: Jwks
  fetchedAt: number
}

const JWKS_TTL_MS = 3_600_000
let cache: CachedJwks | null = null
let cachedFor: string | null = null

async function fetchJwks(url: string): Promise<Jwks> {
  let response: Response
  try {
    response = await fetch(`${url}/auth/v1/.well-known/jwks.json`)
  } catch (error) {
    throw new MintspaceUnavailableError(
      `Could not reach Mintspace's signing keys: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new MintspaceUnavailableError(`Mintspace's signing keys answered ${response.status}.`)
  }

  const body = (await response.json()) as unknown
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    throw new MintspaceUnavailableError('Mintspace served a key set in a shape we cannot read.')
  }
  return { keys: body.keys as Jwk[] }
}

async function signingKeys(url: string, force = false): Promise<Jwks> {
  const now = Date.now()
  if (!force && cache && cachedFor === url && now - cache.fetchedAt < JWKS_TTL_MS) {
    return cache.keys
  }

  const keys = await fetchJwks(url)
  cache = { keys, fetchedAt: Date.now() }
  cachedFor = url
  return keys
}

export function pickJwk(jwks: Jwks, kid: string | null): Jwk | null {
  if (kid) return jwks.keys.find((key) => key.kid === kid) ?? null
  // A key set with exactly one key needs no `kid` to be unambiguous; more than
  // one and a token that names none is simply not verifiable.
  return jwks.keys.length === 1 ? (jwks.keys[0] ?? null) : null
}

async function verifyAsymmetric(
  jwk: Jwk,
  alg: string,
  signed: string,
  signature: Uint8Array,
): Promise<boolean> {
  const data = new TextEncoder().encode(signed) as unknown as ArrayBuffer
  const sig = signature as unknown as ArrayBuffer

  try {
    if (alg === 'RS256') {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)
    }

    if (alg === 'ES256') {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data)
    }
  } catch {
    // A key the runtime will not import cannot verify anything, which is a
    // failed verification rather than an outage.
    return false
  }

  return false
}

async function verifyHmac(secret: string, signed: string, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret) as unknown as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signature as unknown as ArrayBuffer,
      new TextEncoder().encode(signed) as unknown as ArrayBuffer,
    )
  } catch {
    return false
  }
}

/**
 * The Mintspace account behind an access token, or null when it does not hold up.
 *
 * The algorithm is taken from the header only to *dispatch*, never to decide
 * what counts as verified: each branch names the algorithm it checks, and
 * anything outside the three is refused. Accepting whatever a token asks for is
 * how `alg: none` and HMAC-signed-with-the-public-key both work.
 */
export async function mintspaceUser(
  token: string,
  config: MintspaceConfig,
): Promise<MintspaceUser | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  const header = decodeSegment(rawHeader)
  const payload = decodeSegment(rawPayload)
  if (!isRecord(header) || !isRecord(payload)) return null

  const alg = header.alg
  if (alg !== 'RS256' && alg !== 'ES256' && alg !== 'HS256') return null

  const signature = base64UrlToBytes(rawSignature)
  if (!signature) return null

  const signed = `${rawHeader}.${rawPayload}`
  // Deliberately uninitialised: every branch below must assign it, and a
  // default of `false` would let a branch added later fall through to "not
  // verified" quietly rather than failing to compile.
  let verified: boolean

  if (alg === 'HS256') {
    // Legacy projects only. Without the secret configured there is nothing to
    // check against, and guessing is not an option.
    if (!config.jwtSecret) return null
    verified = await verifyHmac(config.jwtSecret, signed, signature)
  } else {
    const kid = typeof header.kid === 'string' ? header.kid : null
    let jwk = pickJwk(await signingKeys(config.url), kid)
    // One forced refetch covers a key rotation that happened inside the cache
    // window; a token naming a key that still does not exist is simply bad.
    if (!jwk) jwk = pickJwk(await signingKeys(config.url, true), kid)
    if (!jwk) return null
    verified = await verifyAsymmetric(jwk, alg, signed, signature)
  }

  if (!verified) return null

  // Compared rather than derived, so a token from another Supabase project
  // signed by a key this one happens to serve is still refused.
  if (payload.iss !== `${config.url}/auth/v1`) return null

  // Supabase stamps every signed-in session with this audience. An anon key —
  // which is also a JWT from this project — carries `role: anon` and no `sub`,
  // and must never be mistaken for a person.
  if (payload.aud !== 'authenticated') return null

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null

  // The uid is what the prefix is built from and what Mintspace's RLS compares
  // against. A prefix keyed on `undefined` would be a shared namespace.
  if (typeof payload.sub !== 'string' || !payload.sub) return null

  return { id: payload.sub }
}

/** Test seam: forget the cached signing keys. */
export function resetForTests(): void {
  cache = null
  cachedFor = null
}
