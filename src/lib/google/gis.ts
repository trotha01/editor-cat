/**
 * Google Drive authorisation.
 *
 * There are two ways to get a Drive token here, and which one is used depends on
 * how the deployment is set up:
 *
 * 1. **The stored connection** (connection.ts, `/api/google/*`). The consent
 *    popup returns an authorisation code, a Netlify function exchanges it for a
 *    refresh token and keeps that server-side, and this module asks for a fresh
 *    access token whenever it needs one. Survives a reload, a restart, and a new
 *    machine — the connection belongs to the account, not to the tab.
 *
 * 2. **Google Identity Services' token flow** (the rest of this file), used when
 *    the deployment has not been set up for the first. GIS hands back an access
 *    token and no refresh token, so a reload has to re-acquire one through a
 *    hidden iframe to accounts.google.com — which browsers increasingly refuse,
 *    leaving the user pressing Reconnect on every visit. That is why option 1
 *    exists; this one remains as the fallback that needs no server.
 *
 * The access token itself is held in memory either way, never in storage. It is
 * the credential Drive actually accepts, and it is cheap to replace; the refresh
 * token, which is not, never reaches this side at all.
 *
 * GIS is script-loaded rather than bundled — Google does not ship it to npm, and
 * self-hosting it is explicitly unsupported because the endpoints it talks to
 * can change under it.
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
import { ConsentDeclinedError, requestAuthorizationCode } from './oauthPopup'

const GIS_SRC = 'https://accounts.google.com/gsi/client'

/**
 * `drive.file` covers everything we upload: an app always keeps access to the
 * files it created. `drive.readonly` is what makes browsing a pre-existing
 * folder possible — per-file scopes cannot list media the app did not write.
 */
export const DRIVE_SCOPE_LIST: [string, ...string[]] = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
]

export const DRIVE_SCOPES = DRIVE_SCOPE_LIST.join(' ')

export function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? ''
}

/** Whether the deployment is configured for Drive at all. */
export function isDriveConfigured(): boolean {
  return clientId().length > 0
}

/** Raised when the user must interact before a token can be issued. */
export class NeedsConsentError extends Error {
  constructor(message = 'Connect your Google account to continue.') {
    super(message)
    this.name = 'NeedsConsentError'
  }
}

let scriptPromise: Promise<void> | null = null

/**
 * Loads the GIS script once, shared by both halves of it: the token client here
 * (Drive authorisation) and the credential client in identity.ts (sign-in).
 */
export function loadGisScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Google sign-in is only available in a browser.'))
      return
    }
    if (window.google?.accounts?.oauth2) {
      resolve()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
    const script = existing ?? document.createElement('script')
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => {
      // Let a later attempt retry rather than caching the failure forever.
      scriptPromise = null
      reject(new Error('Could not reach Google sign-in. Check your connection and try again.'))
    })

    if (!existing) {
      script.src = GIS_SRC
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })
  return scriptPromise
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
let tokenClient: google.accounts.oauth2.TokenClient | null = null

/**
 * Whether this deployment stores connections server-side.
 *
 * `null` until asked. Resolved by `loadConnectionStatus`, which the Drive store
 * calls on mount — well before anyone can reach the Connect button, so the click
 * handler never has to await it and lose its pop-up gesture.
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
 * Also settles `durable` for the rest of the session, which is what lets
 * `connect` decide between the two flows without a round trip.
 */
export async function loadConnectionStatus(): Promise<{ durable: boolean; connected: boolean }> {
  const status = await connectionStatus()
  durable = status.durable
  return { durable: status.durable, connected: status.connected }
}

/** Whether the current connection outlives this tab. Null until first asked. */
export function isDurableConnection(): boolean | null {
  return durable
}

/**
 * The request in flight, if any.
 *
 * GIS fixes its callbacks when the client is built, so the client is created
 * once and its callbacks dispatch to whatever request is currently waiting.
 * Rebuilding a client per request would leak listeners and discard the session
 * state that makes silent renewal work.
 */
let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null

function settle(fn: (waiter: NonNullable<typeof pending>) => void): void {
  const waiter = pending
  if (!waiter) return
  pending = null
  fn(waiter)
}

function onToken(response: google.accounts.oauth2.TokenResponse): void {
  settle(({ resolve, reject }) => {
    if (response.error) {
      reject(
        response.error === 'access_denied'
          ? new NeedsConsentError('Google access was declined.')
          : new Error(response.error_description || response.error),
      )
      return
    }

    // Google may issue fewer scopes than were asked for. Browsing depends on
    // the read scope, so a partial grant has to surface here rather than as a
    // confusing 403 from the folder list later.
    if (!google.accounts.oauth2.hasGrantedAllScopes(response, ...DRIVE_SCOPE_LIST)) {
      reject(new Error(PARTIAL_GRANT))
      return
    }

    const lifetime = Number(response.expires_in) * 1000
    token = {
      value: response.access_token,
      expiresAt: Date.now() + (Number.isFinite(lifetime) ? lifetime : 3_600_000) - EXPIRY_MARGIN_MS,
    }
    resolve(response.access_token)
  })
}

function onError(error: google.accounts.oauth2.ClientConfigError): void {
  // A silent attempt that cannot finish without UI is an expected outcome, not
  // a failure: the caller turns it into a "reconnect" prompt.
  settle(({ reject }) => reject(new NeedsConsentError(errorMessage(error.type))))
}

async function client(): Promise<google.accounts.oauth2.TokenClient> {
  const id = clientId()
  if (!id) {
    throw new Error(
      'Google Drive is not configured for this site: VITE_GOOGLE_CLIENT_ID is not set.',
    )
  }

  await loadGisScript()

  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: DRIVE_SCOPES,
    callback: onToken,
    error_callback: onError,
  })
  return tokenClient
}

/**
 * Runs one token request against GIS.
 *
 * `prompt: ''` asks Google to skip the consent screen when the user has an
 * active session and has already granted these scopes — the case that makes an
 * expired token invisible to the user.
 */
async function request(prompt: '' | 'consent' | 'select_account'): Promise<string> {
  const instance = await client()

  // GIS has no way to cancel an outstanding request, so a second one would
  // resolve against the first one's waiter. Serialising is simpler than
  // tracking which response belongs to which caller.
  if (pending) throw new Error('A Google sign-in is already in progress.')

  return await new Promise<string>((resolve, reject) => {
    pending = { resolve, reject }
    try {
      instance.requestAccessToken({ prompt })
    } catch (cause) {
      settle(() => reject(cause instanceof Error ? cause : new Error(String(cause))))
    }
  })
}

function errorMessage(type: string): string {
  switch (type) {
    case 'popup_closed':
      return 'The Google sign-in window was closed before finishing.'
    case 'popup_failed_to_open':
      return 'The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'
    default:
      return 'Connect your Google account to continue.'
  }
}

/**
 * Starts the consent flow. Must be called from a user gesture — browsers block
 * pop-ups opened from anything else.
 *
 * Prefers the authorisation-code popup, which produces a connection that outlasts
 * the tab. Falls back to the GIS token flow when this deployment cannot store
 * one — either because it was never set up for it, or because the status check
 * had not answered yet when the button was pressed.
 */
export async function connect(): Promise<string> {
  if (durable === false) return await request('consent')

  const id = clientId()
  if (!id) {
    throw new Error(
      'Google Drive is not configured for this site: VITE_GOOGLE_CLIENT_ID is not set.',
    )
  }

  let code: string
  try {
    // Opens the pop-up synchronously, so the click is still what the browser
    // sees. Everything after this point may await freely.
    code = await requestAuthorizationCode(id, DRIVE_SCOPES)
  } catch (cause) {
    // Declining or closing the window is a decision, not a fault: the caller
    // turns it into a reconnect affordance rather than an error banner.
    if (cause instanceof ConsentDeclinedError) throw new NeedsConsentError(cause.message)
    throw cause
  }

  try {
    const grant = await saveConnection(code)
    durable = grant.durable
    return keep(grant)
  } catch (cause) {
    // The site turned out not to store connections after all. The consent just
    // given cannot be used, so run the flow GIS understands instead.
    if (cause instanceof NotDurableError) {
      durable = false
      return await request('consent')
    }
    throw cause
  }
}

/** The silent renewal currently running, shared by everyone waiting on it. */
let renewal: Promise<string> | null = null

/**
 * Mints a token from the stored connection, or falls back to asking GIS.
 *
 * The fallback is not only for deployments without server-side storage: a user
 * who has simply never connected reaches `NoConnectionError` here, and on a
 * build that predates the stored connection they may still have a live GIS
 * session worth resuming.
 */
async function renew(): Promise<string> {
  if (durable !== false) {
    try {
      return keep(await requestAccessToken())
    } catch (cause) {
      // A connection that has been revoked or has aged out is the one case that
      // must reach the user, since only they can put it right.
      if (cause instanceof ConnectionExpiredError) throw new NeedsConsentError(cause.message)

      // Nowhere to store connections here, and that will not change while this
      // page is open — so stop asking.
      if (cause instanceof NotDurableError) durable = false
      // Nothing stored for this account, or a session token that was not
      // accepted just now. Neither is a failure, and neither is permanent: try
      // the flow that needs no server, and ask again next time.
      else if (!(cause instanceof NoConnectionError) && !(cause instanceof SessionRequiredError)) {
        throw cause
      }
    }
  }

  return await request('')
}

/**
 * Returns a usable token, renewing silently when the previous one has aged out.
 *
 * Concurrent callers share one renewal. Generating a batch of images fires
 * several uploads at once, and without this the first would start a request and
 * the rest would fail outright, since GIS cannot have two in flight at a time.
 *
 * Throws `NeedsConsentError` when a token cannot be issued without the user
 * doing something, which is the signal for the caller to show a reconnect button
 * rather than an error.
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

/**
 * Drops our token and tells Google to invalidate it.
 *
 * The stored connection has to go too, or the next load would resume a
 * connection the user just asked to end — which is the whole point of the
 * button. That is cleared first for the same reason: whatever else fails, this
 * site must stop being able to reach their Drive.
 */
export async function disconnect(): Promise<void> {
  const current = token?.value
  token = null

  if (durable !== false) {
    try {
      await clearConnection()
    } catch {
      // Reported nowhere on purpose. The local token is already gone, and the
      // user's own account page can revoke what is left.
    }
  }

  if (!current) return

  try {
    await loadGisScript()
    await new Promise<void>((resolve) => {
      google.accounts.oauth2.revoke(current, () => resolve())
    })
  } catch {
    // Revocation is a courtesy to the user's account page. Failing it must not
    // stop the local disconnect, which has already happened above.
  }
}

/** Test seam: forget cached script/client/token state. */
export function resetForTests(): void {
  scriptPromise = null
  tokenClient = null
  token = null
  pending = null
  renewal = null
  durable = null
}
