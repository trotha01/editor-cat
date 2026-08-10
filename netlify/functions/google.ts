import type { Config } from '@netlify/functions'
import { jsonError } from '../lib/proxy'
import { auth0Config, auth0User, Auth0UnavailableError } from '../lib/auth0'
import {
  googleAccessToken,
  TokenVaultError,
  vaultConfig,
  type VaultConfig,
} from '../lib/tokenVault'

/**
 * A Google Drive access token, on the signed-in user's behalf.
 *
 *   GET  /api/google/status  -> is this deployment set up for Drive, and does
 *                               this caller have a usable Google grant?
 *   POST /api/google/token   -> a fresh Google access token
 *
 * This used to be four routes and a table. The app ran Google's consent itself,
 * exchanged the code here, and kept the refresh token in Postgres under a
 * service-role key — all of it in service of holding one credential that had to
 * outlive an hour.
 *
 * Auth0's Token Vault holds it now. The user consents to Drive at sign-in, as
 * part of the same screen that establishes who they are, and Auth0 keeps what
 * comes back. There is nothing here to store, so `connect` and `disconnect` have
 * no work left to do: the grant arrives with the account, and is withdrawn from
 * the user's Google account page rather than from a button of ours.
 *
 * Authorised with the caller's *Auth0* token rather than the minted Supabase
 * session, which every other function here checks. That is not an inconsistency:
 * the Auth0 token is the subject of the exchange — it is the thing that proves
 * to Auth0 which account's Google grant is being asked for — so a session minted
 * from it would have to be traded back before it could be used, and there is
 * nothing to gain by the round trip.
 */

interface Setup {
  vault: VaultConfig
  audience: string
  domain: string
}

/**
 * Both halves have to be configured. Verifying the caller needs the tenant and
 * the audience; exchanging on their behalf needs the machine client's secret.
 */
function setup(): Setup | null {
  const vault = vaultConfig()
  const auth = auth0Config()
  if (!vault || !auth) return null
  return { vault, audience: auth.audience, domain: auth.domain }
}

/**
 * Says which half is missing, into the function log.
 *
 * The browser is told only that the site is not set up — naming environment
 * variables to anonymous callers tells them nothing they can act on and
 * something about how the site is built. The operator who has to fix it needs
 * the specifics, and the function log is theirs alone.
 */
function reportMissingSetup(): void {
  const missing = [
    vaultConfig() ? null : 'AUTH0_BACKEND_CLIENT_ID and AUTH0_BACKEND_CLIENT_SECRET',
    auth0Config() ? null : 'AUTH0_DOMAIN and AUTH0_AUDIENCE (or their VITE_ forms)',
  ].filter((entry): entry is string => entry !== null)

  console.warn(
    `[google] Drive is disabled: this deployment is missing ${missing.join(' and ')}. ` +
      'Scope them to Functions and redeploy.',
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // A token response is per-user and short-lived; nothing between here and
      // the browser should keep a copy.
      'cache-control': 'no-store',
    },
  })
}

const NOT_CONFIGURED_DETAIL =
  'Set AUTH0_BACKEND_CLIENT_ID and AUTH0_BACKEND_CLIENT_SECRET in the site environment, and ' +
  'turn on Connected Accounts for Token Vault on the Google connection.'

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())
  return match?.[1]?.trim() || null
}

/**
 * Turns a failed exchange into something the browser can act on.
 *
 * `invalid_grant` is the interesting one: Auth0 has no usable Google grant for
 * this account, because consent was withdrawn or never covered the scope being
 * asked for. Signing in again is the cure, and is the only place this app asks
 * Google for anything — so it is reported as a 409, distinct from an outage.
 */
function handleExchangeFailure(error: unknown): Response {
  if (error instanceof TokenVaultError) {
    if (error.code === 'invalid_grant') {
      return jsonError(409, 'Your Google connection expired. Sign in again to restore it.')
    }
    return jsonError(error.status, 'Auth0 refused the Google token request.', error.message)
  }
  return jsonError(
    502,
    'Could not reach Auth0.',
    error instanceof Error ? error.message : String(error),
  )
}

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/api\/google\/?/, '').replace(/\/+$/, '')

  const ready = setup()

  // Answered before any token is required, and the only route that is. The gate
  // asks it to decide whether to offer Drive at all, and all it discloses is
  // whether the deployment is set up for it — which the README states publicly.
  // Anything about a *user* still needs their token.
  if (route === 'status') {
    if (!ready) {
      reportMissingSetup()
      return json({ durable: false, connected: false, problem: 'not-configured' })
    }

    const token = bearerToken(request)
    if (!token) return json({ durable: true, connected: false })

    let caller
    try {
      caller = await auth0User(token, { domain: ready.domain, audience: ready.audience })
    } catch {
      // Auth0 did not answer. The question asked was whether this deployment can
      // reach Drive, and an unanswerable check is not evidence that it cannot.
      return json({ durable: true, connected: false })
    }
    if (!caller) return json({ durable: true, connected: false })

    try {
      await googleAccessToken(token, ready.vault)
      return json({ durable: true, connected: true })
    } catch (error) {
      if (error instanceof TokenVaultError && error.code === 'invalid_grant') {
        return json({ durable: true, connected: false })
      }
      console.warn(
        `[google] Token Vault did not answer: ${error instanceof Error ? error.message : String(error)}`,
      )
      return json({ durable: true, connected: false, problem: 'unreachable' })
    }
  }

  if (route !== 'token') return jsonError(404, 'No such Drive endpoint.')
  if (request.method !== 'POST') return jsonError(405, 'Use POST to get a Drive token.')

  if (!ready) {
    reportMissingSetup()
    return jsonError(503, 'This site is not set up for Google Drive.', NOT_CONFIGURED_DETAIL)
  }

  const token = bearerToken(request)
  if (!token) return jsonError(401, 'Sign in to continue.', 'No Auth0 token was sent.')

  let caller
  try {
    caller = await auth0User(token, { domain: ready.domain, audience: ready.audience })
  } catch (error) {
    return jsonError(
      502,
      'Could not check who you are just now.',
      error instanceof Auth0UnavailableError ? error.message : String(error),
    )
  }
  if (!caller) return jsonError(401, 'Sign in to continue.', 'Auth0 did not accept that token.')

  try {
    const grant = await googleAccessToken(token, ready.vault)
    return json({ accessToken: grant.accessToken, expiresIn: grant.expiresIn, scope: grant.scope })
  } catch (error) {
    return handleExchangeFailure(error)
  }
}

export const config: Config = {
  path: '/api/google/*',
}
