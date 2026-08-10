import type { Config } from '@netlify/functions'
import { jsonError } from '../lib/proxy'
import { IdentityUnavailableError, identityUser } from '../lib/identity'
import { supabaseProjectUrl } from '../lib/supabase'
import { SESSION_LIFETIME_SECONDS, mintSessionToken, supabaseJwtSecret } from '../lib/supabaseToken'

/**
 * Trading a Netlify Identity token for a Supabase session.
 *
 *   GET  /api/session  -> can this deployment mint sessions at all? Answered
 *                         without a token, because the sign-in screen has to
 *                         know before it offers a button.
 *   POST /api/session  -> verify the caller's Netlify Identity token and mint
 *                         the Supabase session that goes with it.
 *
 * This is the seam between the two halves of the app's identity. Netlify
 * Identity owns the login — it is what the Google consent at the gate goes
 * through — and Supabase owns the data, behind row-level security that only
 * trusts tokens signed with the project's own secret. Neither will accept the
 * other's, so one endpoint stands between them and converts.
 *
 * Everything the browser does afterwards carries the minted token: Supabase
 * reads and writes directly under RLS, and this site's own functions verify it
 * locally (see netlify/lib/auth.ts). The Identity round trip therefore happens
 * once an hour per user rather than once per request.
 */

const NOT_CONFIGURED_DETAIL =
  'Set SUPABASE_JWT_SECRET (Supabase → Project settings → API → JWT keys) in the site ' +
  'environment, scoped to Functions, alongside SUPABASE_URL or VITE_SUPABASE_URL.'

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
  ].filter((entry): entry is string => entry !== null)

  console.warn(
    `[session] Sign-in is disabled: this deployment is missing ${missing.join(' and ')}. ` +
      'Scope it to Functions and redeploy.',
  )
}

export default async (request: Request): Promise<Response> => {
  const secret = supabaseJwtSecret()
  const projectUrl = supabaseProjectUrl()
  const ready = secret.length > 0 && projectUrl.length > 0

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
  if (!token) return jsonError(401, 'Sign in to continue.', 'No Netlify Identity token was sent.')

  let user
  try {
    user = await identityUser(token, request.url)
  } catch (error) {
    // Identity did not answer, which is not the visitor's fault and is not
    // fixed by signing in again.
    return jsonError(
      502,
      'Could not check who you are just now.',
      error instanceof IdentityUnavailableError ? error.message : String(error),
    )
  }

  if (!user) {
    return jsonError(401, 'Sign in to continue.', 'Netlify Identity did not accept that token.')
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
