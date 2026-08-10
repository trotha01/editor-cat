/**
 * The server half of a Google Drive connection that survives a reload.
 *
 * The browser-only token flow this app started with issues an access token and
 * nothing else: an hour later it is gone, and re-acquiring one silently needs a
 * hidden iframe to accounts.google.com that browsers increasingly refuse. So the
 * connection appeared to drop on every reload, and Settings showed a Reconnect
 * button the user had to keep pressing.
 *
 * The authorisation-code flow fixes that, at the cost of needing somewhere to
 * keep a refresh token. That somewhere is here. The page runs the consent flow
 * and comes back with a one-time code; only this side holds the client secret
 * that turns the code into a refresh token, and only this side ever sees the
 * refresh token afterwards. The browser is handed nothing but the hour-long
 * access token it needs to call Drive — the same exposure it had before.
 *
 * Everything here reads *unprefixed* environment variables. A `VITE_` prefix
 * would inline the client secret into the browser bundle, which would defeat the
 * entire point of moving this off the page.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/**
 * Where Google sends the browser back to after consent.
 *
 * Served by the app itself (the SPA fallback covers it) rather than by a
 * function, because a function response would have to carry inline script to
 * hand the code back to the opener — and the site's CSP does not allow inline
 * script. The app bundle is `'self'`, so it does.
 *
 * Kept in step with `CALLBACK_PATH` in `src/lib/google/oauthPopup.ts` by hand:
 * the browser and the functions are separate TypeScript projects, and a shared
 * import across them would drag the app's DOM lib into the function build.
 */
export const CALLBACK_PATH = '/oauth/google'

export interface OauthConfig {
  clientId: string
  clientSecret: string
}

/**
 * The credentials for the code exchange, or null when this deployment has not
 * been set up for it.
 *
 * `GOOGLE_CLIENT_ID` falls back to the build-time `VITE_` variable because it is
 * the same value and the same OAuth client — asking an operator to set one
 * string twice is how the two drift apart. The *secret* has no such fallback:
 * there is no `VITE_` form of it, by design.
 */
export function oauthConfig(): OauthConfig | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? process.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

/**
 * The redirect URI, which must be byte-identical in three places: the
 * authorisation request the page makes, the exchange below, and the Google
 * console's authorised list.
 *
 * Derived from the request rather than taken from the caller, so there is no
 * client-supplied value to validate. `GOOGLE_REDIRECT_URI` overrides it, which
 * is what a site whose deploys have URLs of their own needs: the browser sent
 * one registered origin as `redirect_uri` (see `callbackOrigin` in
 * src/lib/google/oauthPopup.ts) and Google compares this against that one, not
 * against the host this function happens to be answering on.
 *
 * Which makes it a per-deploy-context variable: it belongs in exactly the
 * contexts that set a shared callback origin for the browser, and nowhere else.
 * Production, whose URL is its own, wants it unset and derives the same answer
 * here that the browser already asked with. In one place but not the other,
 * Google sees two different URIs and refuses the exchange — after a consent
 * screen that looked like it worked.
 */
export function redirectUri(requestUrl: string): string {
  const override = (process.env.GOOGLE_REDIRECT_URI ?? '').trim()
  if (override) return override
  return `${new URL(requestUrl).origin}${CALLBACK_PATH}`
}

/**
 * A failure with a status worth passing on to the browser.
 *
 * `code` carries Google's own machine-readable reason, of which `invalid_grant`
 * is the one that matters: it says the stored refresh token is dead — revoked
 * from the account page, or unused for six months — and the only cure is to ask
 * the user to connect again. Everything else is ours or Google's to fix, and
 * reads as a plain upstream failure.
 */
export class GoogleOauthError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'GoogleOauthError'
    this.status = status
    this.code = code
  }
}

export interface TokenGrant {
  accessToken: string
  /** Seconds. */
  expiresIn: number
  scope: string
  /** Absent when Google decided the existing grant still stands. */
  refreshToken: string | null
}

interface RawTokenResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  refresh_token?: string
  error?: string
  error_description?: string
}

/** Google's own default, used when a response omits `expires_in`. */
const DEFAULT_LIFETIME_SECONDS = 3600

export type Fetcher = typeof fetch

async function postForm(
  endpoint: string,
  body: Record<string, string>,
  fetchImpl: Fetcher,
): Promise<Response> {
  return await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
}

/** Turns whatever Google answered into a grant, or throws something explicable. */
async function readGrant(response: Response): Promise<TokenGrant> {
  let body: RawTokenResponse = {}
  try {
    body = (await response.json()) as RawTokenResponse
  } catch {
    // A non-JSON body (an outage page, say) leaves the status to speak.
  }

  if (!response.ok || !body.access_token) {
    const code = body.error ?? 'token_request_failed'
    throw new GoogleOauthError(
      // `invalid_grant` is the user's problem to fix by reconnecting, so it is
      // reported as a 409 rather than a 502: nothing is broken here.
      code === 'invalid_grant' ? 409 : 502,
      code,
      body.error_description ?? `Google refused the token request (${response.status}).`,
    )
  }

  return {
    accessToken: body.access_token,
    expiresIn: Number.isFinite(body.expires_in)
      ? Number(body.expires_in)
      : DEFAULT_LIFETIME_SECONDS,
    scope: body.scope ?? '',
    refreshToken: body.refresh_token ?? null,
  }
}

/**
 * Turns the one-time code from the consent popup into tokens.
 *
 * A refresh token comes back only when the authorisation request asked for one
 * *and* Google treated the grant as fresh — see `authorizationUrl` in
 * `src/lib/google/oauthPopup.ts`, which is where those two parameters are set.
 * `refreshToken` is nullable here because the caller has to cope either way: a
 * grant Google considered unchanged still yields a usable access token, just not
 * a durable connection.
 */
export async function exchangeCode(
  code: string,
  config: OauthConfig,
  callbackUri: string,
  fetchImpl: Fetcher = fetch,
): Promise<TokenGrant> {
  const response = await postForm(
    TOKEN_ENDPOINT,
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  )
  return await readGrant(response)
}

/** Mints a fresh access token from a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  config: OauthConfig,
  fetchImpl: Fetcher = fetch,
): Promise<TokenGrant> {
  const response = await postForm(
    TOKEN_ENDPOINT,
    {
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    },
    fetchImpl,
  )
  return await readGrant(response)
}

/**
 * Asks Google to invalidate a token and everything derived from it.
 *
 * Best-effort on purpose: the caller has already deleted its own copy by the
 * time this runs, so a failure here leaves a credential that nothing can present
 * — a tidiness problem on the user's account page, not an access one.
 */
export async function revokeToken(token: string, fetchImpl: Fetcher = fetch): Promise<void> {
  try {
    await postForm(REVOKE_ENDPOINT, { token }, fetchImpl)
  } catch {
    // Deliberately swallowed. See above.
  }
}
