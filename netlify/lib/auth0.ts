/**
 * Who Auth0 says a caller is.
 *
 * Netlify Identity signed its tokens with a secret the site never saw, so the
 * only way to check one was to ask GoTrue — a round trip, on the one path that
 * could least afford surprises. Auth0 signs with RS256 and publishes the public
 * half at a well-known URL, so this side can verify a token without leaving the
 * process. The JWKS is fetched once and cached; a token naming a key not in it
 * triggers one refetch, which is how a rotated signing key is picked up without
 * a deploy.
 *
 * `/api/session` is still the only caller. It trades a verified Auth0 token for
 * the hour-long Supabase session that everything else carries, and auth.ts
 * verifies *that* — so the shape is unchanged, one hop cheaper.
 */

export interface Auth0User {
  id: string
  email: string
}

/**
 * Raised when Auth0 could not be asked, as opposed to answering "no".
 *
 * Kept apart from a plain `null` because the two mean opposite things: a token
 * that fails verification is the visitor's problem and answers 401, while a JWKS
 * that could not be fetched is ours and answers 502. Merging them would tell
 * someone to sign in again during an outage that signing in again cannot fix.
 */
export class Auth0UnavailableError extends Error {
  constructor(detail: string) {
    super(`Could not reach Auth0: ${detail}`)
    this.name = 'Auth0UnavailableError'
  }
}

/** Beyond this it is not a diagnostic any more, it is a payload. */
const DETAIL_LIMIT = 200

export interface Auth0Config {
  /** Bare hostname, no scheme and no trailing slash. */
  domain: string
  /** The API identifier tokens must be minted for. */
  audience: string
}

/**
 * How this deployment reaches Auth0, or null when it was not set up for it.
 *
 * `VITE_` fallbacks because these are the same two public values the browser is
 * built with, and asking an operator to set one string twice is how the two
 * drift apart. Neither is a secret: the domain is in every authorisation URL and
 * the audience is in every token.
 */
export function auth0Config(): Auth0Config | null {
  const domain = (process.env.AUTH0_DOMAIN ?? process.env.VITE_AUTH0_DOMAIN ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  const audience = (process.env.AUTH0_AUDIENCE ?? process.env.VITE_AUTH0_AUDIENCE ?? '').trim()
  if (!domain || !audience) return null
  return { domain, audience }
}

/**
 * The claim an Auth0 Action may add to carry the address into the access token.
 *
 * Optional, and empty is a perfectly good answer: the browser reads the address
 * out of its own ID token, and nothing on this side does more than copy it into
 * the minted session for whoever reads claims later. Namespaced because Auth0
 * silently drops custom claims that are not.
 */
export const EMAIL_CLAIM = 'https://editor-cat/email'

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

interface Jwks {
  keys?: Jwk[]
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The signing key with this `kid`, or null when the set does not carry one. */
export function pickJwk(jwks: Jwks, kid: string | null): Jwk | null {
  const keys = Array.isArray(jwks.keys) ? jwks.keys : []
  const usable = keys.filter((key) => key.kty === 'RSA' && key.n && key.e)
  if (!kid) return usable.length === 1 ? (usable[0] ?? null) : null
  return usable.find((key) => key.kid === kid) ?? null
}

interface CachedJwks {
  keys: Jwks
  fetchedAt: number
}

/** An hour. Long enough that this is not a hot path, short enough to self-heal. */
const JWKS_TTL_MS = 3_600_000

let cache: CachedJwks | null = null

async function fetchJwks(domain: string): Promise<Jwks> {
  const endpoint = `https://${domain}/.well-known/jwks.json`

  let response: Response
  try {
    response = await fetch(endpoint)
  } catch (cause) {
    throw new Auth0UnavailableError(
      (cause instanceof Error ? cause.message : String(cause)).slice(0, DETAIL_LIMIT),
    )
  }

  if (!response.ok) throw new Auth0UnavailableError(`${endpoint} answered ${response.status}`)

  try {
    return (await response.json()) as Jwks
  } catch {
    throw new Auth0UnavailableError(`${endpoint} did not answer with JSON`)
  }
}

/**
 * The signing keys, from cache when it is fresh.
 *
 * `force` skips the cache, which is what an unrecognised `kid` asks for: Auth0
 * rotates signing keys, and the first token signed with a new one would
 * otherwise fail until the TTL expired.
 */
async function signingKeys(domain: string, force = false): Promise<Jwks> {
  if (!force && cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS) return cache.keys

  const keys = await fetchJwks(domain)
  cache = { keys, fetchedAt: Date.now() }
  return keys
}

async function verifySignature(jwk: Jwk, signed: string, signature: Uint8Array): Promise<boolean> {
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    // A key the runtime will not import cannot verify anything, which is a
    // failed verification rather than an outage.
    return false
  }

  return await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(signed) as unknown as ArrayBuffer,
  )
}

/** Whether `aud` — a string or an array, per the spec — covers the audience. */
export function audienceMatches(aud: unknown, audience: string): boolean {
  if (typeof aud === 'string') return aud === audience
  if (Array.isArray(aud)) return aud.some((entry) => entry === audience)
  return false
}

/**
 * The account behind an Auth0 access token, or null when it does not hold up.
 *
 * Everything a token has to prove is checked here and nothing is assumed from
 * the caller: the signature against Auth0's published key, the issuer, the
 * audience, and the expiry. A token missing `sub` is treated as no user at all —
 * that id is the key everything this app stores is filed under, and a row keyed
 * on `undefined` is worse than a refused sign-in.
 */
export async function auth0User(token: string, config: Auth0Config): Promise<Auth0User | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  const header = decodeSegment(rawHeader)
  const payload = decodeSegment(rawPayload)
  if (!isRecord(header) || !isRecord(payload)) return null

  // Named explicitly rather than trusted from the header: accepting whatever
  // algorithm a token asks for is how `alg: none` and HMAC-with-the-public-key
  // both work.
  if (header.alg !== 'RS256') return null

  const kid = typeof header.kid === 'string' ? header.kid : null

  let jwk = pickJwk(await signingKeys(config.domain), kid)
  if (!jwk) jwk = pickJwk(await signingKeys(config.domain, true), kid)
  if (!jwk) return null

  const verified = await verifySignature(
    jwk,
    `${rawHeader}.${rawPayload}`,
    base64UrlToBytes(rawSignature),
  )
  if (!verified) return null

  // Auth0's issuer always carries the trailing slash. Compared rather than
  // derived, so a token from another tenant signed by a key this one happens to
  // serve is still refused.
  if (payload.iss !== `https://${config.domain}/`) return null
  if (!audienceMatches(payload.aud, config.audience)) return null

  // An unbounded session is not something to accept by omission.
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null

  if (typeof payload.sub !== 'string' || !payload.sub) return null

  const email = payload[EMAIL_CLAIM] ?? payload.email
  return { id: payload.sub, email: typeof email === 'string' ? email : '' }
}

/** Test seam: forget the cached signing keys. */
export function resetForTests(): void {
  cache = null
}
