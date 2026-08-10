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
 * The session it checks is the Auth0 access token itself. It used to be a
 * Supabase-shaped JWT this site signed with the project's own secret, because
 * Supabase would not accept an Auth0 token and something had to convert; with
 * Auth0 registered on the project as a third-party auth provider there is
 * nothing left to convert, and no second credential to check. So this asks
 * auth0.ts, which is where verifying an Auth0 token already lived — one verifier
 * rather than two, and the one that was already checking issuer and audience.
 *
 * Verification stays local, which is not a nicety. One video generation polls
 * for minutes, and a round trip to Auth0 per poll would be both slow and rude to
 * a service that is not being paid to answer them. What makes it local is the
 * JWKS cache in auth0.ts: an hour's worth of signing keys held in the module,
 * refetched once when a token names a key id it has not seen. The signature
 * check itself is arithmetic over bytes already in hand. Nothing here may
 * reintroduce a per-request call to the tenant.
 *
 * The browser sends the *access* token here, not the ID token Supabase gets:
 * `aud` is checked against this site's API, and only the access token carries
 * it. See src/lib/falClient.ts.
 *
 * Every *secret* here reads an unprefixed environment variable. A `VITE_` prefix
 * would inline the value into the browser bundle, which is exactly the mistake
 * this module exists to avoid. Neither value this one reads is a secret — the
 * tenant domain is in every authorisation URL and the audience is in every token
 * — which is why both accept their `VITE_` forms.
 */
import { jsonError } from './proxy'
import { Auth0UnavailableError, auth0Config, auth0User } from './auth0'

/**
 * Escape hatch for `netlify dev` against a checkout with no Auth0 tenant.
 * Deliberately opt-in: the default has to be "refuse" rather than "allow", or a
 * forgotten variable in production silently reopens the endpoint.
 */
function allowAnonymous(): boolean {
  return process.env.FAL_PROXY_ALLOW_ANONYMOUS === '1'
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

  const config = auth0Config()

  if (!config) {
    // An operator misconfiguration, not something the visitor did wrong.
    return {
      ok: false,
      response: jsonError(
        503,
        'This site is not set up to authorise generation requests.',
        'Set AUTH0_DOMAIN and AUTH0_AUDIENCE — or their VITE_ forms, which are ' +
          'the same tenant and API — or FAL_PROXY_ALLOW_ANONYMOUS=1 for local development.',
      ),
    }
  }

  const token = bearerToken(request)
  if (!token) return { ok: false, response: unauthorised('No session token was sent.') }

  let user
  try {
    // Signature, issuer, audience and expiry, all of them in auth0.ts. Nothing
    // is re-checked here: a second opinion about a token that has already been
    // verified is how the two drift apart, and the looser one wins.
    user = await auth0User(token, config)
  } catch (error) {
    // The tenant's signing keys could not be fetched. Not the visitor's fault
    // and not fixed by signing in again, so it must not be reported as a
    // rejected token — which is the difference between telling someone to wait
    // and sending them round a login that was never the problem.
    return {
      ok: false,
      response: jsonError(
        502,
        'Could not check who you are just now.',
        error instanceof Auth0UnavailableError ? error.message : String(error),
      ),
    }
  }

  if (!user) return { ok: false, response: unauthorised('That session could not be verified.') }

  return { ok: true, userId: user.id }
}
