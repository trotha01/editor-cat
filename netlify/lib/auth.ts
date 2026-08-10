/**
 * Proving the caller is a signed-in user of this site.
 *
 * The fal proxy used to be harmless: it forwarded the caller's own key, so an
 * unauthenticated request could only ever spend the caller's own money. Now the
 * key belongs to the deployment, which turns `/api/fal/*` into a button that
 * spends the operator's credits — and anyone who finds the URL could hold it
 * down. So the proxy verifies the session the editor already requires (see
 * src/components/SignInGate.tsx).
 *
 * The session it checks is the one `/api/session` mints: a Supabase-shaped JWT
 * signed with the project's own secret, carrying the Netlify Identity user id in
 * `sub`. Verification is therefore local — an HMAC over bytes we already have,
 * with no call to Netlify, Supabase, or anyone else. That matters because one
 * video generation polls for minutes, and a round trip per poll would be both
 * slow and rude to a service that is not being paid to answer them. It is also
 * the whole reason the Identity check happens once at the mint rather than here.
 *
 * Every *secret* here reads an unprefixed environment variable. A `VITE_` prefix
 * would inline the value into the browser bundle, which is exactly the mistake
 * this module exists to avoid.
 */
import { jsonError } from './proxy'
import { SESSION_ISSUER, supabaseJwtSecret } from './supabaseToken'

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
  claims: JwtClaims
  /** The `<header>.<payload>` bytes the signature covers. */
  signedData: Uint8Array<ArrayBuffer>
  signature: Uint8Array<ArrayBuffer>
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
 * A minute of leeway absorbs clock skew between the minting function and the
 * one checking. A token with no `exp` at all counts as expired — an unbounded
 * session is not something to accept by omission.
 */
export function isExpired(claims: JwtClaims, nowSeconds: number, leewaySeconds = 60): boolean {
  if (typeof claims.exp !== 'number') return true
  return nowSeconds > claims.exp + leewaySeconds
}

async function verifyHmac(jwt: DecodedJwt, secret: string): Promise<boolean> {
  // Checked rather than assumed: without it `alg` would be attacker-controlled,
  // and "none" or a downgrade to a family we do not verify would sail through.
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

  const secret = supabaseJwtSecret()

  if (!secret) {
    // An operator misconfiguration, not something the visitor did wrong.
    return {
      ok: false,
      response: jsonError(
        503,
        'This site is not set up to authorise generation requests.',
        'Set SUPABASE_JWT_SECRET — the same secret /api/session signs with — or ' +
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

  // A token this site did not mint, however well signed. Checked before the
  // signature so that a Supabase-issued token — same secret, same project,
  // different issuer — is refused rather than quietly accepted as one of ours.
  if (jwt.claims.iss !== SESSION_ISSUER) {
    return { ok: false, response: unauthorised('That session was not issued by this site.') }
  }

  // An unusable key is a failed verification, never a reason to let the request
  // through — so the rejection becomes a `false` rather than a 500.
  const verified = await verifyHmac(jwt, secret).catch(() => false)

  if (!verified) {
    return { ok: false, response: unauthorised('That session could not be verified.') }
  }

  return { ok: true, userId: jwt.claims.sub ?? null }
}
