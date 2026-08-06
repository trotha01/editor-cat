/**
 * Google Drive authorisation.
 *
 * There is one way in, and it is signing in: the consent screen at the gate asks
 * for identity and Drive together, a Netlify function exchanges the code it
 * returns for a refresh token and keeps that server-side, and this module asks
 * for a fresh access token whenever it needs one. See connection.ts and
 * `/api/google/*`.
 *
 * This file used to carry a second path built on Google Identity Services, for
 * deployments with no server behind them. It is gone. GIS splits its two jobs
 * across libraries that cannot do each other's, so using it meant asking the user
 * for Google twice — once to sign in, once for Drive, from a button buried in
 * Settings. One prompt was worth more than the fallback.
 *
 * The access token is held in memory, never in storage. It is the credential
 * Drive actually accepts, and it is cheap to replace; the refresh token, which is
 * neither, never reaches this side at all.
 */
import {
  ConnectionExpiredError,
  NoConnectionError,
  NotDurableError,
  SessionRequiredError,
  clearConnection,
  connectionStatus,
  requestAccessToken,
  saveConnection,
  type DriveGrant,
} from './connection'

/**
 * `drive.file` covers everything we upload: an app always keeps access to the
 * files it created. `drive.readonly` is what makes browsing a pre-existing
 * folder possible — per-file scopes cannot list media the app did not write.
 */
export const DRIVE_SCOPE_LIST: readonly string[] = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
]

export const DRIVE_SCOPES = DRIVE_SCOPE_LIST.join(' ')

/**
 * What signing in asks for: who you are, plus Drive.
 *
 * Asked together because they are one decision. Splitting them meant two trips to
 * Google and a backup that quietly did nothing until someone found the second
 * button — which is the whole reason this list exists.
 *
 * The Drive half can still be unticked on Google's own screen. That grant cannot
 * do anything, so it is dropped rather than stored, and the gate asks again.
 */
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile', ...DRIVE_SCOPE_LIST].join(' ')

export function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? ''
}

/** Whether the deployment is configured for Drive at all. */
export function isDriveConfigured(): boolean {
  return clientId().length > 0
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
 * Whether this deployment stores connections server-side.
 *
 * `null` until asked. Resolved by `loadConnectionStatus`, which the gate calls
 * before drawing anything — a site that cannot store a connection cannot sign
 * anyone in either, and says so rather than offering a button that fails after
 * the user has already consented.
 */
let durable: boolean | null = null

/** Renew a minute early; a token that expires mid-upload fails the whole upload. */
const EXPIRY_MARGIN_MS = 60_000

function validToken(): string | null {
  if (token && token.expiresAt > Date.now()) return token.value
  return null
}

/** The message shown when Google issued only some of what was asked for. */
const PARTIAL_GRANT =
  'Google Drive access was only partly granted. Both permissions are needed: one to save your ' +
  'media, one to browse the folder you pick.'

function grantsAllScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  return DRIVE_SCOPE_LIST.every((needed) => granted.has(needed))
}

/** Caches a grant from the stored connection and hands back its access token. */
function keep(grant: DriveGrant): string {
  // The stored connection reports its scopes too, and a partial grant has to
  // surface here rather than as a confusing 403 from the folder list later.
  if (!grantsAllScopes(grant.scope)) throw new Error(PARTIAL_GRANT)

  token = {
    value: grant.accessToken,
    expiresAt: Date.now() + grant.expiresIn * 1000 - EXPIRY_MARGIN_MS,
  }
  return grant.accessToken
}

/**
 * Asks the server whether a connection is stored for this account.
 *
 * Also settles `durable` for the rest of the session. A `false` here means the
 * deployment is missing its client secret or service role key, which the gate
 * reports as an operator error — there is no degraded mode left to fall into.
 */
export async function loadConnectionStatus(): Promise<{ durable: boolean; connected: boolean }> {
  const status = await connectionStatus()
  durable = status.durable
  return status
}

/** Whether this site can store a connection at all. Null until first asked. */
export function isDurableConnection(): boolean | null {
  return durable
}

/**
 * Turns the consent code from the sign-in screen into a stored connection and a
 * live token.
 */
export async function adoptConnection(code: string): Promise<string> {
  const grant = await saveConnection(code)
  durable = grant.durable

  try {
    return keep(grant)
  } catch (cause) {
    // Someone who unticked Drive on the consent screen leaves a connection that
    // cannot do anything. Storing it would mean resuming it on every load and
    // failing the same way each time, so it is dropped and reported instead.
    await clearConnection().catch(() => {})
    throw cause
  }
}

/** The renewal currently running, shared by everyone waiting on it. */
let renewal: Promise<string> | null = null

/**
 * Mints a token from the stored connection.
 *
 * Every way of not having one ends the same way — the user has to sign in again,
 * which is the only place this app asks for Google. So they all become
 * `NeedsConsentError` rather than four different failures the callers would each
 * have to know about.
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
