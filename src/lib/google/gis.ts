/**
 * Google Drive authorisation.
 *
 * Granted at sign-in rather than after it: the Auth0 login names Drive as a
 * connection scope, so one Google screen covers the account and the folder
 * together, and Auth0 keeps the tokens that come back. This module asks
 * `/api/google/token` for a fresh access token whenever it needs one, which is
 * answered by exchanging the caller's Auth0 token through Token Vault. See
 * ../auth0/client.ts and connection.ts.
 *
 * There is no separate Drive prompt any more, and no consent code to adopt. The
 * two-screen flow was a cost of Netlify Identity, whose login proved who someone
 * was and nothing more; Auth0 can carry the scope, so the second screen is gone.
 *
 * The access token is held in memory, never in storage. It is the credential
 * Drive actually accepts and it is cheap to replace; the refresh token behind it
 * is Auth0's, and never reaches this side at all.
 *
 * The filename is a leftover. It was Google Identity Services once, which could
 * not do any of this — kept only because renaming it would touch every importer
 * for no behavioural gain.
 */
import { DRIVE_SCOPE_LIST, isAuth0Configured } from '../auth0/client'
import {
  ConnectionExpiredError,
  NoConnectionError,
  NotDurableError,
  SessionRequiredError,
  connectionStatus,
  requestAccessToken,
  type ConnectionStatus,
  type DriveGrant,
} from './connection'

export { DRIVE_SCOPE_LIST }

export const DRIVE_SCOPES = DRIVE_SCOPE_LIST.join(' ')

/**
 * Whether the deployment is configured for Drive at all.
 *
 * Which is now the same question as whether it can sign anyone in: Drive rides
 * on the Auth0 login, so a site with no Auth0 settings has neither.
 */
export function isDriveConfigured(): boolean {
  return isAuth0Configured()
}

/** Raised when the user must interact before a token can be issued. */
export class NeedsConsentError extends Error {
  constructor(message = 'Sign in again to reach your Google Drive.') {
    super(message)
    this.name = 'NeedsConsentError'
  }
}

interface StoredToken {
  value: string
  /** Epoch millis, already reduced by a safety margin. */
  expiresAt: number
}

/**
 * Access tokens are held in memory only. Persisting one would leave a working
 * Drive credential in localStorage for anything with script access on the origin
 * to read, and replacing it costs one request to our own function.
 */
let token: StoredToken | null = null

/**
 * Whether this deployment can reach Drive.
 *
 * `null` until asked. Resolved by `loadConnectionStatus`, which the gate calls
 * before drawing anything — a site that cannot reach Drive cannot sign anyone in
 * either, and says so rather than offering a button that fails after the user
 * has already consented.
 */
let durable: boolean | null = null

/** Renew a minute early; a token that expires mid-upload fails the whole upload. */
const EXPIRY_MARGIN_MS = 60_000

function validToken(): string | null {
  if (token && token.expiresAt > Date.now()) return token.value
  return null
}

/** The message shown when Google issued less than was asked for. */
const PARTIAL_GRANT =
  'Google Drive access was not granted. The editor saves your media to your own Drive, so it ' +
  'cannot open without it.'

function grantsAllScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  return DRIVE_SCOPE_LIST.every((needed) => granted.has(needed))
}

/** Caches a grant and hands back its access token. */
function keep(grant: DriveGrant): string {
  // Token Vault reports the scopes the grant actually carries, and a partial one
  // has to surface here rather than as a confusing 403 from the folder list
  // later. An empty scope is not evidence of a partial grant — it means the
  // exchange did not say — so it is only checked when something came back.
  if (grant.scope && !grantsAllScopes(grant.scope)) throw new Error(PARTIAL_GRANT)

  token = {
    value: grant.accessToken,
    expiresAt: Date.now() + grant.expiresIn * 1000 - EXPIRY_MARGIN_MS,
  }
  return grant.accessToken
}

/**
 * Asks the server whether this deployment and this account can reach Drive.
 *
 * Also settles `durable` for the rest of the session. A `false` here is the end
 * of the road — there is no degraded mode left to fall into — so the reason
 * comes back with it for the gate to show, which is the only thing anyone can
 * act on from that screen.
 */
export async function loadConnectionStatus(): Promise<ConnectionStatus> {
  const status = await connectionStatus()
  durable = status.durable
  return status
}

/** Whether this site can reach Drive at all. Null until first asked. */
export function isDurableConnection(): boolean | null {
  return durable
}

/** The renewal currently running, shared by everyone waiting on it. */
let renewal: Promise<string> | null = null

/**
 * Mints a token through the Token Vault exchange.
 *
 * Every way of not getting one ends the same way — the user has to sign in
 * again, which is the only place this app asks Google for anything. So they all
 * become `NeedsConsentError` rather than four different failures the callers
 * would each have to know about.
 */
async function renew(): Promise<string> {
  try {
    return keep(await requestAccessToken())
  } catch (cause) {
    if (
      cause instanceof ConnectionExpiredError ||
      cause instanceof NoConnectionError ||
      cause instanceof SessionRequiredError ||
      cause instanceof NotDurableError
    ) {
      throw new NeedsConsentError(cause.message)
    }
    throw cause
  }
}

/**
 * Returns a usable token, renewing when the previous one has aged out.
 *
 * Concurrent callers share one renewal. Generating a batch of images fires
 * several uploads at once, and without this each would mint its own token.
 *
 * Throws `NeedsConsentError` when a token cannot be issued without the user
 * doing something, which is the signal for the caller to point them back at
 * signing in rather than to show an error.
 */
export async function accessToken(): Promise<string> {
  const current = validToken()
  if (current) return current

  if (!renewal) {
    const attempt = renew()
    renewal = attempt
    // Cleared however it settles, but only if a newer attempt has not already
    // replaced it. Handling the rejection here as well keeps a renewal nobody
    // happened to await from surfacing as an unhandled rejection.
    const clear = () => {
      if (renewal === attempt) renewal = null
    }
    attempt.then(clear, clear)
  }

  return await renewal
}

/** True when a token is held right now, without triggering a request. */
export function hasToken(): boolean {
  return validToken() !== null
}

/**
 * Forgets the current token so the next `accessToken` call fetches a new one.
 *
 * Drive answers 401 for a token revoked from the user's account page well
 * before our own expiry clock would have noticed, so the API layer calls this
 * and retries rather than trusting `expiresAt` alone.
 */
export function invalidateToken(): void {
  token = null
}

/** Test seam: forget cached token and configuration state. */
export function resetForTests(): void {
  token = null
  renewal = null
  durable = null
}
