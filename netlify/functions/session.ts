import type { Config } from '@netlify/functions'
import { jsonError } from '../lib/proxy'
import { Auth0UnavailableError, auth0Config, auth0User } from '../lib/auth0'
import { supabaseProjectUrl } from '../lib/supabase'
import { SESSION_LIFETIME_SECONDS, mintSessionToken, supabaseJwtSecret } from '../lib/supabaseToken'

/**
 * Trading an Auth0 token for a Supabase session.
 *
 *   GET  /api/session  -> can this deployment mint sessions at all? Answered
 *                         without a token, because the sign-in screen has to
 *                         know before it offers a button.
 *   POST /api/session  -> verify the caller's Auth0 token and mint the Supabase
 *                         session that goes with it.
 *
 * This is the seam between the two halves of the app's identity. Auth0 owns the
 * login — it is what the Google consent at the gate goes through, and what
 * carries the Drive scope with it — and Supabase owns the data, behind row-level
 * security that only trusts tokens signed with the project's own secret. Neither
 * will accept the other's, so one endpoint stands between them and converts.
 *
 * Everything the browser does afterwards carries the minted token: Supabase
 * reads and writes directly under RLS, and this site's own functions verify it
 * locally (see netlify/lib/auth.ts). `/api/google/*` is the one exception, and
 * takes the Auth0 token instead — it is the subject of the Token Vault exchange,
 * so nothing else will do.
 */

const NOT_CONFIGURED_DETAIL =
  'Set SUPABASE_JWT_SECRET (Supabase → Project settings → API → JWT keys) in the site ' +
  'environment, scoped to Functions, alongside SUPABASE_URL or VITE_SUPABASE_URL and the ' +
  'AUTH0_DOMAIN / AUTH0_AUDIENCE pair.'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // A session token is per-user and short-lived; nothing between here and
      // the browser should keep a copy.
      'cache-control': 'no-store',
    },
  })
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())
  return match?.[1]?.trim() || null
}

/**
 * Says which variable is missing, into the function log.
 *
 * The browser is told only that the site is not set up. Naming environment
 * variables to anonymous callers tells them nothing they can act on and
 * something about how the site is built — but the operator who has to fix it
 * needs the specifics, and the function log is theirs alone.
 */
function reportMissingSetup(secret: string, projectUrl: string): void {
  const missing = [
    secret ? null : 'SUPABASE_JWT_SECRET',
    projectUrl ? null : 'SUPABASE_URL (or VITE_SUPABASE_URL)',
    auth0Config() ? null : 'AUTH0_DOMAIN and AUTH0_AUDIENCE (or their VITE_ forms)',
  ].filter((entry): entry is string => entry !== null)

  console.warn(
    `[session] Sign-in is disabled: this deployment is missing ${missing.join(' and ')}. ` +
      'Scope it to Functions and redeploy.',
  )
}

export default async (request: Request): Promise<Response> => {
  const secret = supabaseJwtSecret()
  const projectUrl = supabaseProjectUrl()
  const auth = auth0Config()
  const ready = secret.length > 0 && projectUrl.length > 0 && auth !== null

  if (request.method === 'GET') {
    if (!ready) {
      reportMissingSetup(secret, projectUrl)
      return json({ ready: false, problem: 'not-configured' })
    }
    return json({ ready: true })
  }

  if (request.method !== 'POST') return jsonError(405, 'Use POST to start a session.')

  if (!ready) {
    reportMissingSetup(secret, projectUrl)
    return jsonError(503, 'This site is not set up for sign-in.', NOT_CONFIGURED_DETAIL)
  }

  const token = bearerToken(request)
  if (!token) return jsonError(401, 'Sign in to continue.', 'No Auth0 token was sent.')

  let user
  try {
    // `auth` is non-null here: `ready` is what guarantees it, and the 503 above
    // is the only way past a deployment without it.
    user = await auth0User(token, auth as NonNullable<typeof auth>)
  } catch (error) {
    // Auth0's signing keys could not be fetched, which is not the visitor's
    // fault and is not fixed by signing in again.
    return jsonError(
      502,
      'Could not check who you are just now.',
      error instanceof Auth0UnavailableError ? error.message : String(error),
    )
  }

  if (!user) {
    return jsonError(401, 'Sign in to continue.', 'Auth0 did not accept that token.')
  }

  return json({
    access_token: await mintSessionToken(user, secret),
    expires_in: SESSION_LIFETIME_SECONDS,
    user: { id: user.id, email: user.email },
  })
}

export const config: Config = {
  path: '/api/session',
}
