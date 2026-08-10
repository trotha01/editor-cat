import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { jsonError } from '../lib/proxy'
import {
  deleteConnection,
  MissingTableError,
  readConnection,
  StoreError,
  storeConfig,
  writeConnection,
  type StoreConfig,
} from '../lib/googleConnections'
import {
  exchangeCode,
  GoogleOauthError,
  oauthConfig,
  redirectUri,
  refreshAccessToken,
  revokeToken,
  type OauthConfig,
} from '../lib/googleOauth'

/**
 * Keeps a Google Drive connection alive across reloads.
 *
 * The editor used to hold a Drive access token in memory and nothing else, so
 * closing the tab ended the connection and Settings asked the user to reconnect
 * on every visit. This endpoint holds the refresh token instead — server-side,
 * where the client secret already lives — and mints a short-lived access token
 * whenever the browser asks for one.
 *
 *   GET  /api/google/status      -> is this deployment set up, and is this user
 *                                   connected? Answered without touching Google.
 *   POST /api/google/connect     -> exchange the consent code for tokens, store
 *                                   the refresh token, return the access token
 *   POST /api/google/token       -> a fresh access token from the stored one
 *   POST /api/google/disconnect  -> revoke at Google and forget the token
 *
 * The refresh token never appears in a response body. What the browser gets is
 * the same hour-long access token it always had.
 *
 * Storing anything needs a verified session, because the user id from that
 * session is the key the refresh token is filed under. That id comes from
 * Netlify Identity by way of `/api/session`, which is also why anonymous local
 * development (`FAL_PROXY_ALLOW_ANONYMOUS=1`) cannot use this path at all —
 * there is no account to file a connection under, and `status` says so plainly.
 *
 * `connect` is reached from the gate's Drive step, which runs immediately after
 * signing in: Netlify Identity cannot carry a Drive scope through its own login,
 * so the consent that produces this code is asked for separately.
 */

interface Setup {
  oauth: OauthConfig
  store: StoreConfig
}

/**
 * Why this deployment cannot keep Drive connected, when it cannot.
 *
 * Told to the browser because the sign-in screen has to say something true
 * about a site it is refusing to let anyone into, and one message covering
 * every cause is what sends an operator to re-check the half that was already
 * right. None of these names a value — only which step of the setup is
 * unfinished, which the README states publicly anyway.
 *
 * Mirrored by `StatusProblem` in src/lib/google/connection.ts.
 */
type StatusProblem =
  /** The function environment is missing a secret it cannot work without. */
  | 'not-configured'
  /** Configured, but the migration that creates the table was never run. */
  | 'no-table'
  /** Configured and migrated; the store did not answer just now. */
  | 'unreachable'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Both halves have to be configured; either one alone is not usable. */
function setup(): Setup | null {
  const oauth = oauthConfig()
  const store = storeConfig()
  if (!oauth || !store) return null
  return { oauth, store }
}

/**
 * Says which half is missing, into the function log.
 *
 * The browser is told only that the site is not set up — naming environment
 * variables to anonymous callers tells them nothing they need and something
 * about how the site is built. But the operator who has to fix it needs the
 * specifics, and the function log is theirs alone. Without this, a site that
 * refuses every sign-in looks identical whichever variable is absent.
 */
function reportMissingSetup(): void {
  const missing = [
    oauthConfig() ? null : 'GOOGLE_CLIENT_SECRET (and GOOGLE_CLIENT_ID, or VITE_GOOGLE_CLIENT_ID)',
    storeConfig() ? null : 'SUPABASE_SERVICE_ROLE_KEY (and SUPABASE_URL, or VITE_SUPABASE_URL)',
  ].filter((entry): entry is string => entry !== null)

  console.warn(
    `[google] Sign-in is disabled: this deployment is missing ${missing.join(' and ')}. ` +
      'Scope them to Functions, redeploy, and run supabase/migrations/0002_google_connections.sql.',
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
  'Set GOOGLE_CLIENT_SECRET and SUPABASE_SERVICE_ROLE_KEY in the site environment to keep Drive ' +
  'connected between visits.'

/**
 * Reports a failed token request without leaking the parts that are ours.
 *
 * `invalid_grant` is the interesting one: it means the stored refresh token no
 * longer works — revoked from the user's account page, or expired after six
 * months unused — so the row is dropped and the browser is told to ask for
 * consent again rather than retrying forever against a dead credential.
 */
async function handleOauthFailure(
  error: unknown,
  userId: string,
  store: StoreConfig,
): Promise<Response> {
  if (error instanceof GoogleOauthError) {
    if (error.code === 'invalid_grant') {
      try {
        await deleteConnection(userId, store)
      } catch {
        // The row will be overwritten by the next successful connect anyway.
      }
      return jsonError(409, 'Your Google connection expired. Connect Drive again in Settings.')
    }
    return jsonError(error.status, 'Google refused the request.', error.message)
  }

  return jsonError(502, 'Could not reach Google.', describe(error))
}

async function readCode(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { code?: unknown }
    return typeof body.code === 'string' && body.code.trim() ? body.code.trim() : null
  } catch {
    return null
  }
}

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/api\/google\/?/, '').replace(/\/+$/, '')

  const ready = setup()

  // Deliberately answered before any session is required, and the only route
  // that is. The gate asks it to decide whether to offer the Drive button at
  // all, and a session that lapsed while a laptop slept must not turn "this
  // site keeps connections" into "this site does not". All it discloses is
  // whether the deployment is set up for that, which the README states
  // publicly; anything about a *user* still needs their token.
  if (route === 'status') {
    const unusable = (problem: StatusProblem, detail?: string) =>
      json({ durable: false, connected: false, problem, ...(detail ? { detail } : {}) })

    if (!ready) {
      reportMissingSetup()
      return unusable('not-configured')
    }

    const caller = await requireSession(request)
    // Signed out, or an anonymous development build with no account to file a
    // connection under. Either way there is nothing of theirs to report.
    if (!caller.ok || !caller.userId) return json({ durable: true, connected: false })

    try {
      const stored = await readConnection(caller.userId, ready.store)
      return json({ durable: true, connected: stored !== null })
    } catch (error) {
      // Answered 200, not 502, on purpose. The question asked was "can this
      // deployment keep Drive connected", and "no, because the table is
      // missing" is an answer to it. A 502 collapses the reason back into
      // "something went wrong", which is then all the browser can show.
      if (error instanceof MissingTableError) {
        console.warn(
          `[google] ${error.message} Run supabase/migrations/0002_google_connections.sql ` +
            'against this project.',
        )
        return unusable('no-table')
      }

      console.warn(`[google] Could not reach the connection store: ${describe(error)}`)
      // The database's own words, and only to a caller who is already signed in.
      // Whoever is standing a deployment up is the first person to sign into it,
      // and "permission denied for table google_connections" is the difference
      // between fixing it now and going to look for a function log.
      return unusable('unreachable', error instanceof StoreError ? error.summary : undefined)
    }
  }

  const session = await requireSession(request)
  if (!session.ok) return session.response

  if (!ready) {
    reportMissingSetup()
    return jsonError(503, 'This site does not keep Drive connected.', NOT_CONFIGURED_DETAIL)
  }
  if (!session.userId) {
    return jsonError(
      503,
      'This site does not keep Drive connected.',
      'Anonymous access cannot store a Google connection: there is no account to file it under.',
    )
  }
  const userId = session.userId

  if (route === 'connect') {
    if (request.method !== 'POST') return jsonError(405, 'Use POST to connect Drive.')

    const code = await readCode(request)
    if (!code) return jsonError(400, 'That Google authorisation could not be read. Try again.')

    let grant
    try {
      grant = await exchangeCode(code, ready.oauth, redirectUri(request.url))
    } catch (error) {
      return await handleOauthFailure(error, userId, ready.store)
    }

    // Google withholds the refresh token when it decides the existing grant
    // still stands. The authorisation request asks for consent every time
    // precisely to avoid that, but if it happens anyway the previous token is
    // still the right one to keep — and when there is no previous token, the
    // connection simply is not durable and the browser is told so rather than
    // being left to discover it an hour later.
    let durable = true
    try {
      if (grant.refreshToken) {
        await writeConnection(
          userId,
          { refreshToken: grant.refreshToken, scope: grant.scope },
          ready.store,
        )
      } else {
        durable = (await readConnection(userId, ready.store)) !== null
      }
    } catch (error) {
      return jsonError(
        502,
        'Connected to Google, but could not save the connection for next time.',
        describe(error),
      )
    }

    return json({
      access_token: grant.accessToken,
      expires_in: grant.expiresIn,
      scope: grant.scope,
      durable,
    })
  }

  if (route === 'token') {
    if (request.method !== 'POST') return jsonError(405, 'Use POST to request a Drive token.')

    let stored
    try {
      stored = await readConnection(userId, ready.store)
    } catch (error) {
      return jsonError(502, 'Could not read your Google connection.', describe(error))
    }

    // Not an error worth alarming anyone with: this user has simply never
    // connected Drive, and the browser treats it as "offer the button".
    if (!stored) return jsonError(404, 'No Google Drive connection is saved for this account.')

    try {
      const grant = await refreshAccessToken(stored.refreshToken, ready.oauth)
      return json({
        access_token: grant.accessToken,
        expires_in: grant.expiresIn,
        // A refresh response echoes the granted scopes; fall back to what was
        // recorded at connect time for the rare response that omits them.
        scope: grant.scope || stored.scope,
      })
    } catch (error) {
      return await handleOauthFailure(error, userId, ready.store)
    }
  }

  if (route === 'disconnect') {
    if (request.method !== 'POST') return jsonError(405, 'Use POST to disconnect Drive.')

    try {
      const stored = await readConnection(userId, ready.store)
      // Deleted first: if revocation hangs or fails, the connection is still
      // gone from this site's point of view, which is what the user asked for.
      await deleteConnection(userId, ready.store)
      if (stored) await revokeToken(stored.refreshToken)
    } catch (error) {
      return jsonError(502, 'Could not disconnect Google Drive.', describe(error))
    }

    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }

  return jsonError(404, 'Unknown Google endpoint.')
}

export const config: Config = {
  path: '/api/google/*',
}
