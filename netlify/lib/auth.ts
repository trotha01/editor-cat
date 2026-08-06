/**
 * Proving the caller is a signed-in user of this site.
 *
 * The fal proxy used to be harmless: it forwarded the caller's own key, so an
 * unauthenticated request could only ever spend the caller's own money. Now the
 * key belongs to the deployment, which turns `/api/fal/*` into a button that
 * spends the operator's credits — and anyone who finds the URL could hold it
 * down. So the proxy verifies the Supabase session the editor already requires
 * (see src/components/SignInGate.tsx).
 *
 * Verification is local: the signature is checked against Supabase's published
 * keys rather than by asking Supabase about every request. One video
 * generation polls for minutes, so a round trip per poll would be both slow and
 * rude to a service that is not being paid to answer them.
 *
 * Every *secret* here reads an unprefixed environment variable. A `VITE_` prefix
 * would inline the value into the browser bundle, which is exactly the mistake
 * this module exists to avoid. The project URL is the one exception, and only
 * because it is not a secret — see `supabaseProjectUrl`.
 */
import { jsonError } from './proxy'
import { supabaseProjectUrl } from './supabase'

/** Set only on projects still signing with the legacy shared secret. */
function jwtSecret(): string {
  return (process.env.SUPABASE_JWT_SECRET ?? '').trim()
}

/**
 * Escape hatch for `netlify dev` against a checkout with no Supabase project.
 * Deliberately opt-in: the default has to be "refuse" rather than "allow", or a
 * forgotten variable in production silently reopens the endpoint.
 */
function allowAnonymous(): boolean {
  return process.env.FAL_PROXY_ALLOW_ANONYMOUS === '1'
}

export interface JwtClaims {
  sub?: string
  exp?: number
  iss?: string
}

export interface DecodedJwt {
  alg: string
  kid: string | null
  claims: JwtClaims
  /** The `<header>.<payload>` bytes the signature covers. */
  signedData: Uint8Array<ArrayBuffer>
  signature: Uint8Array<ArrayBuffer>
}

export interface Jwks {
  keys?: JsonWebKey[]
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Splits a JWT into its parts without trusting any of them yet. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [rawHeader = '', rawPayload = '', rawSignature = ''] = parts
  const header = decodeJsonSegment(rawHeader)
  const claims = decodeJsonSegment(rawPayload)
  const signature = base64UrlToBytes(rawSignature)

  if (!header || !claims || !signature || typeof header.alg !== 'string') return null

  return {
    alg: header.alg,
    kid: typeof header.kid === 'string' ? header.kid : null,
    claims: {
      sub: typeof claims.sub === 'string' ? claims.sub : undefined,
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
      iss: typeof claims.iss === 'string' ? claims.iss : undefined,
    },
    signedData: new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    signature,
  }
}

/**
 * A minute of leeway absorbs clock skew between Supabase and the function host.
 * A token with no `exp` at all counts as expired — an unbounded session is not
 * something to accept by omission.
 */
export function isExpired(claims: JwtClaims, nowSeconds: number, leewaySeconds = 60): boolean {
  if (typeof claims.exp !== 'number') return true
  return nowSeconds > claims.exp + leewaySeconds
}

/** Finds the key a token names, or the only key there is when it names none. */
export function pickJwk(jwks: Jwks, kid: string | null): JsonWebKey | null {
  const keys = jwks.keys ?? []
  if (kid) return keys.find((key) => (key as { kid?: string }).kid === kid) ?? null
  return keys.length === 1 ? (keys[0] ?? null) : null
}

let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null

/** How long to wait before believing an unknown `kid` warrants another fetch. */
const JWKS_REFETCH_INTERVAL_MS = 60_000

async function fetchJwks(baseUrl: string): Promise<JsonWebKey[]> {
  const response = await fetch(`${baseUrl}/auth/v1/.well-known/jwks.json`)
  if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`)
  const body = (await response.json()) as Jwks
  return body.keys ?? []
}

/**
 * The signing key for a token, refetching the set when the `kid` is unknown.
 *
 * Functions stay warm across the submit and the many status polls that follow,
 * so caching turns one fetch into one per cold start. Rate-limiting the refetch
 * matters too: without it, a token bearing a junk `kid` would let anyone make
 * us hammer the JWKS endpoint.
 */
async function signingKey(baseUrl: string, kid: string | null): Promise<JsonWebKey | null> {
  const cached = jwksCache ? pickJwk({ keys: jwksCache.keys }, kid) : null
  if (cached) return cached

  const dueForRefetch = !jwksCache || Date.now() - jwksCache.fetchedAt > JWKS_REFETCH_INTERVAL_MS
  if (!dueForRefetch) return null

  const keys = await fetchJwks(baseUrl)
  jwksCache = { keys, fetchedAt: Date.now() }
  return pickJwk({ keys }, kid)
}

/** Test seam: drop the cached key set. */
export function resetJwksCacheForTests(): void {
  jwksCache = null
}

async function verifyAsymmetric(jwt: DecodedJwt, jwk: JsonWebKey): Promise<boolean> {
  if (jwt.alg === 'ES256') {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      jwt.signature,
      jwt.signedData,
    )
  }

  if (jwt.alg === 'RS256') {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signedData)
  }

  return false
}

async function verifyHmac(jwt: DecodedJwt, secret: string): Promise<boolean> {
  if (jwt.alg !== 'HS256') return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, jwt.signature, jwt.signedData)
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/**
 * Phrased for the person who will see it. Every failure here means "sign in
 * again", so none of them should read like an internal error.
 */
function unauthorised(detail: string): Response {
  return jsonError(401, 'Sign in to generate.', detail)
}

export type SessionResult =
  /** `userId` is null only in the anonymous local-development case. */
  { ok: true; userId: string | null } | { ok: false; response: Response }

export async function requireSession(request: Request): Promise<SessionResult> {
  if (allowAnonymous()) return { ok: true, userId: null }

  const baseUrl = supabaseProjectUrl()
  const secret = jwtSecret()

  if (!baseUrl && !secret) {
    // An operator misconfiguration, not something the visitor did wrong.
    return {
      ok: false,
      response: jsonError(
        503,
        'This site is not set up to authorise generation requests.',
        'Set SUPABASE_URL — or VITE_SUPABASE_URL, which is the same public string — plus ' +
          'SUPABASE_JWT_SECRET if the project signs with a shared secret, or ' +
          'FAL_PROXY_ALLOW_ANONYMOUS=1 for local development.',
      ),
    }
  }

  const token = bearerToken(request)
  if (!token) return { ok: false, response: unauthorised('No session token was sent.') }

  const jwt = decodeJwt(token)
  if (!jwt) return { ok: false, response: unauthorised('That session token is not readable.') }

  if (isExpired(jwt.claims, Math.floor(Date.now() / 1000))) {
    return { ok: false, response: unauthorised('That session has expired.') }
  }

  if (baseUrl && jwt.claims.iss !== `${baseUrl}/auth/v1`) {
    return { ok: false, response: unauthorised('That session was issued by another project.') }
  }

  let verified = false
  try {
    if (jwt.alg === 'HS256') {
      verified = secret.length > 0 && (await verifyHmac(jwt, secret))
    } else if (baseUrl) {
      const jwk = await signingKey(baseUrl, jwt.kid)
      verified = jwk !== null && (await verifyAsymmetric(jwt, jwk))
    }
  } catch {
    // An unreachable JWKS endpoint or an unusable key is a failed verification,
    // never a reason to let the request through.
    verified = false
  }

  if (!verified) {
    return { ok: false, response: unauthorised('That session could not be verified.') }
  }

  return { ok: true, userId: jwt.claims.sub ?? null }
}
