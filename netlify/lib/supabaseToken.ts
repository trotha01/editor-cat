/**
 * Minting the session token the browser actually carries.
 *
 * Netlify Identity says who someone is; Supabase will not take its word for it.
 * Its row-level security reads `auth.uid()` out of a JWT signed with the
 * project's own secret, so an Identity token presented to PostgREST is simply
 * rejected — different issuer, different key, no session.
 *
 * So this signs one. The claims describe the Netlify account (`sub` is the
 * Identity user id) in the shape Supabase expects, using the project's signing
 * secret, and the result is a perfectly ordinary Supabase session as far as
 * Postgres is concerned: `auth.uid()` returns the Identity id, and the existing
 * `auth.uid() = user_id` policies keep working untouched. This is the same shape
 * as Supabase's own third-party auth integrations — the external provider stays
 * the identity, and RLS stays the thing that guards the data.
 *
 * The one thing that does *not* survive is the foreign key to `auth.users`:
 * there is no row there for a Netlify account. See
 * supabase/migrations/0003_netlify_identity.sql.
 *
 * The same token is what `/api/fal/*` and `/api/google/*` check, which is why
 * they can verify it locally — see auth.ts. That is deliberate: it puts the one
 * round trip to Netlify Identity at the mint, not on every poll of a video job.
 */
import type { IdentityUser } from './identity'

/**
 * Who these tokens say issued them.
 *
 * Not the Supabase project URL, because the Supabase project did not issue them
 * — this site did, and a claim that says otherwise is one more thing that is not
 * true in a log. Fixed rather than derived from the request host so that staging,
 * deploy previews and production all mint the same issuer: `auth.ts` compares
 * against it, and a value that moved per deploy would reject a token the moment
 * a session outlived the branch it was minted on.
 *
 * Postgres does not care either way — PostgREST validates the signature and the
 * expiry, not the issuer.
 */
export const SESSION_ISSUER = 'editor-cat'

/**
 * An hour, matching what Supabase Auth itself issues.
 *
 * Short because the token is a bearer credential for the user's own rows and
 * cannot be revoked once minted; an hour is also long enough that a browser
 * re-mints roughly as often as it would have refreshed a real session.
 */
export const SESSION_LIFETIME_SECONDS = 3600

/**
 * The project's signing secret. No `VITE_` fallback, ever.
 *
 * Every other Supabase value this site reads has one, because they are public.
 * This one mints sessions: a `VITE_` prefix would inline it into the browser
 * bundle and hand every visitor the ability to sign in as anybody.
 */
export function supabaseJwtSecret(): string {
  return (process.env.SUPABASE_JWT_SECRET ?? '').trim()
}

/**
 * Base64url, over UTF-8 bytes rather than characters.
 *
 * `btoa` refuses anything outside Latin-1, so encoding the JSON first is not a
 * formality: an address with an accent in it would otherwise throw here and take
 * out sign-in for that one account, which is the kind of failure nobody
 * reproduces. It is also what the JWT spec asks for.
 */
function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface SessionClaims {
  sub: string
  email: string
  aud: 'authenticated'
  role: 'authenticated'
  iss: typeof SESSION_ISSUER
  iat: number
  exp: number
  /** Which external system vouched for this user, for anything reading claims later. */
  app_metadata: { provider: 'netlify' }
}

export function sessionClaims(user: IdentityUser, nowSeconds: number): SessionClaims {
  return {
    sub: user.id,
    email: user.email,
    // `role` is the one claim Postgres acts on by itself: PostgREST switches to
    // the role named here, and `authenticated` is what the RLS policies are
    // written against. Anything else would read the tables as `anon`.
    aud: 'authenticated',
    role: 'authenticated',
    iss: SESSION_ISSUER,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_LIFETIME_SECONDS,
    app_metadata: { provider: 'netlify' },
  }
}

/** Signs a Supabase-shaped session for an Identity user. */
export async function mintSessionToken(
  user: IdentityUser,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify(sessionClaims(user, nowSeconds)))
  const data = `${header}.${payload}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))

  return `${data}.${base64Url(new Uint8Array(signature))}`
}
