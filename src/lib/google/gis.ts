/**
 * Google sign-in, via Google Identity Services.
 *
 * GIS is script-loaded rather than bundled — Google does not ship it to npm,
 * and self-hosting it is explicitly unsupported because the endpoints it talks
 * to can change under it.
 *
 * The flow here is the browser-side token flow, which hands back an access
 * token and no refresh token. That is a deliberate trade: a refresh token in a
 * static site is a long-lived credential sitting in storage with no server to
 * protect it. The cost is that tokens expire after roughly an hour, so
 * `accessToken` below re-acquires silently when it can and reports
 * `needsConsent` when it cannot.
 */

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
 * Tokens are held in memory only. Persisting them would leave a working Drive
 * credential in localStorage for anything with script access on the origin to
 * read, and re-acquiring one silently is cheap.
 */
let token: StoredToken | null = null
let tokenClient: google.accounts.oauth2.TokenClient | null = null

/** Renew a minute early; a token that expires mid-upload fails the whole upload. */
const EXPIRY_MARGIN_MS = 60_000

function validToken(): string | null {
  if (token && token.expiresAt > Date.now()) return token.value
  return null
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
      reject(
        new Error(
          'Google Drive access was only partly granted. Both permissions are needed: one to save your media, one to browse the folder you pick.',
        ),
      )
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
 */
export async function connect(): Promise<string> {
  return await request('consent')
}

/** The silent renewal currently running, shared by everyone waiting on it. */
let renewal: Promise<string> | null = null

/**
 * Returns a usable token, renewing silently when the previous one has aged out.
 *
 * Concurrent callers share one renewal. Generating a batch of images fires
 * several uploads at once, and without this the first would start a request and
 * the rest would fail outright, since GIS cannot have two in flight at a time.
 *
 * Throws `NeedsConsentError` when Google will not issue a token without UI,
 * which is the signal for the caller to show a reconnect button rather than an
 * error.
 */
export async function accessToken(): Promise<string> {
  const current = validToken()
  if (current) return current

  if (!renewal) {
    const attempt = request('')
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

/** Drops our token and tells Google to invalidate it. */
export async function disconnect(): Promise<void> {
  const current = token?.value
  token = null
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
}
