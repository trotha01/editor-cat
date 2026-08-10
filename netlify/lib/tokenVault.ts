/**
 * Getting a Google access token out of Auth0, on the user's behalf.
 *
 * This app used to run the Google consent itself and keep the refresh token in a
 * table of its own, because the browser-only token flow issues an access token
 * and nothing else — an hour later it is gone, and the connection appeared to
 * drop on every reload. All of that machinery existed to hold one credential
 * safely.
 *
 * Token Vault holds it instead. The user's Google tokens are stored against
 * their Auth0 account when they consent at sign-in, and this exchanges the Auth0
 * access token the browser already sent for a Google one. Google's refresh token
 * never reaches this process at all, which is a stronger version of the property
 * the old design was built to get: there is no longer a refresh token here to
 * leak, and no table to migrate, back up or lose.
 *
 * The exchange is an ordinary RFC 8693 token exchange with an Auth0-specific
 * `requested_token_type`. It needs client credentials of its own — a machine
 * client, not the SPA's — because it is a confidential call and the browser must
 * never be able to make it.
 */

/**
 * Auth0's own grant type, not RFC 8693's generic one.
 *
 * The exchange is a token exchange in every other respect, so
 * `urn:ietf:params:oauth:grant-type:token-exchange` is the obvious guess and it
 * is wrong: Auth0 accepts it, gets as far as reading the token types, and
 * answers "Invalid subject_token_type and requested_token_type combination" —
 * which points at the two parameters that were right, and not at the one that
 * was not.
 */
const TOKEN_EXCHANGE_GRANT =
  'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token'

/**
 * The access-token variant, which is the one a backend API can use.
 *
 * Token Vault also exchanges an Auth0 *refresh* token, but a browser never
 * sends one of those to its own API — it sends an access token, which is what
 * arrives here.
 */
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
const FEDERATED_TOKEN_TYPE = 'http://auth0.com/oauth/token-type/federated-connection-access-token'

/** Auth0's own name for the Google social connection, in every tenant. */
export const GOOGLE_CONNECTION = 'google-oauth2'

export interface VaultConfig {
  /** Bare hostname, no scheme. */
  domain: string
  clientId: string
  clientSecret: string
}

/**
 * The credentials for the exchange, or null when this deployment has not been
 * set up for it.
 *
 * These belong to the API's **Custom API Client**, not to a machine-to-machine
 * application. Access token exchange is the variant where the caller is the
 * resource server the subject token was minted for, and Auth0 checks that by
 * whose credentials authenticated the request: a plain M2M client, however
 * generously granted, answers "This client is not a resource server and cannot
 * exchange access tokens." The Custom API Client shares the API's identifier,
 * which is what makes it the same entity.
 *
 * Its own client rather than the SPA's either way: this one holds a secret, and
 * the SPA's cannot. `AUTH0_DOMAIN` falls back to the build-time `VITE_` form
 * because it is the same tenant regardless — the *secret* has no such fallback,
 * by design.
 */
export function vaultConfig(): VaultConfig | null {
  const domain = (process.env.AUTH0_DOMAIN ?? process.env.VITE_AUTH0_DOMAIN ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  const clientId = (process.env.AUTH0_BACKEND_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.AUTH0_BACKEND_CLIENT_SECRET ?? '').trim()
  if (!domain || !clientId || !clientSecret) return null
  return { domain, clientId, clientSecret }
}

/**
 * A failure with a status worth passing on to the browser.
 *
 * `code` carries Auth0's own machine-readable reason. `invalid_grant` is the one
 * that matters: it means there is no usable Google grant behind this account any
 * more — consent was withdrawn from the Google account page, or was never given
 * for the scope being asked for — and the only cure is to send the user back
 * through sign-in. Everything else is ours or Auth0's to fix.
 */
export class TokenVaultError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TokenVaultError'
    this.code = code
    this.status = status
  }
}

export interface GoogleGrant {
  accessToken: string
  /** Seconds. */
  expiresIn: number
  scope: string
}

interface RawExchangeResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

/** Google's own default, used when a response omits `expires_in`. */
const DEFAULT_LIFETIME_SECONDS = 3600

export type Fetcher = typeof fetch

/**
 * Trades the caller's Auth0 access token for a Google one.
 *
 * The subject token is the token the browser sent, already verified against the
 * tenant's published keys before reaching here (see auth0.ts) — and Auth0
 * verifies it again on its own account, which is what makes this safe to call
 * with a value that arrived over the wire.
 */
export async function googleAccessToken(
  subjectToken: string,
  config: VaultConfig,
  fetchImpl: Fetcher = fetch,
): Promise<GoogleGrant> {
  let response: Response
  try {
    response = await fetchImpl(`https://${config.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token_type: ACCESS_TOKEN_TYPE,
        subject_token: subjectToken,
        requested_token_type: FEDERATED_TOKEN_TYPE,
        connection: GOOGLE_CONNECTION,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    })
  } catch (cause) {
    throw new TokenVaultError(
      502,
      'unreachable',
      cause instanceof Error ? cause.message : String(cause),
    )
  }

  let body: RawExchangeResponse = {}
  try {
    body = (await response.json()) as RawExchangeResponse
  } catch {
    // A non-JSON body (an outage page, say) leaves the status to speak.
  }

  if (!response.ok || !body.access_token) {
    const code = body.error ?? 'token_exchange_failed'
    const description =
      body.error_description ?? `Auth0 refused the token exchange (${response.status}).`

    throw new TokenVaultError(
      // Two ways of saying the same thing, and both are the user's to fix by
      // consenting again rather than anything being broken here: `invalid_grant`
      // is the documented one, and a missing federated refresh token is what
      // Auth0 actually answers when Google issued none — which is the ordinary
      // outcome for a returning user whose consent Google considers to stand.
      // Reported as 409 so the gate offers a sign-in rather than a reload.
      code === 'invalid_grant' || /refresh token not found/i.test(description) ? 409 : 502,
      code,
      // Auth0's own code travels with its description. The description alone
      // reads like prose and says nothing a branch can be written against.
      `${code}: ${description}`,
    )
  }

  return {
    accessToken: body.access_token,
    expiresIn: Number.isFinite(body.expires_in)
      ? Number(body.expires_in)
      : DEFAULT_LIFETIME_SECONDS,
    scope: body.scope ?? '',
  }
}
