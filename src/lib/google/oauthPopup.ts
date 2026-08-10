/**
 * The trip to Google that authorises Drive.
 *
 * The plain OAuth endpoint rather than Google's own browser library: GIS offers
 * only the implicit token flow, which issues no refresh token, so a connection
 * made through it dies within the hour. Asking for `response_type=code` by hand
 * is what makes a durable connection possible at all — the code goes to a
 * Netlify function, which exchanges it for a refresh token it keeps.
 *
 * A pop-up rather than a redirect because reconnecting Drive can happen from
 * Settings with a project open, and it must not navigate away mid-edit. A window
 * of our own rather than an iframe because Google refuses to render consent in
 * one.
 */

/**
 * Where Google sends the browser back to.
 *
 * Handled by the app itself: Netlify's SPA fallback serves index.html for this
 * path, and main.tsx peels it off before React mounts (see oauthCallback.ts).
 * Serving it from a function instead would need inline script to reach the
 * opener, which the site's Content-Security-Policy does not allow.
 *
 * Must stay in step with `CALLBACK_PATH` in `netlify/lib/googleOauth.ts`, which
 * rebuilds the same URI for the code exchange — Google compares the two — and
 * with the authorised redirect URI registered in the Google console.
 */
export const CALLBACK_PATH = '/oauth/google'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Marks a message as ours, so an unrelated `postMessage` cannot resolve a wait. */
export const CALLBACK_MESSAGE = 'editor-cat.google.oauth'

export interface CallbackMessage {
  source: typeof CALLBACK_MESSAGE
  state: string
  code?: string
  error?: string
}

export function callbackUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`
}

export interface AuthorizationRequest {
  clientId: string
  /** Space-delimited. */
  scope: string
  /** Defaults to re-asking for consent. See below for why that matters. */
  prompt?: string
  /**
   * The address already signed in, so Google does not ask which account.
   *
   * Only a hint: someone with several accounts can still switch. It exists
   * because this consent now follows a Netlify Identity sign-in that already
   * settled the question, and asking it twice is the cost of splitting them.
   */
  loginHint?: string
}

export interface Authorization {
  code: string
}

/**
 * The URL the consent pop-up opens.
 *
 * Two parameters carry the whole feature:
 *
 * - `access_type=offline` is what asks for a refresh token at all.
 * - `prompt=consent` is what makes Google issue one *again* for someone who has
 *   already granted these scopes. A refresh token only comes back with a fresh
 *   grant, so without this a returning user would connect successfully and still
 *   find themselves disconnected an hour later — the exact complaint this path
 *   exists to answer.
 */
export function authorizationUrl(request: AuthorizationRequest, state: string): string {
  const params = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: callbackUri(),
    response_type: 'code',
    scope: request.scope,
    access_type: 'offline',
    prompt: request.prompt ?? 'consent',
    include_granted_scopes: 'true',
    state,
  })
  if (request.loginHint) params.set('login_hint', request.loginHint)
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/** Raised when the user closed the window or declined, rather than something breaking. */
export class ConsentDeclinedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConsentDeclinedError'
  }
}

/** How often to check whether the popup was closed without answering. */
const CLOSE_POLL_MS = 400

const POPUP_FEATURES = 'popup=yes,width=520,height=660,left=100,top=60'

/**
 * Opens the consent pop-up and resolves with what Google sent back.
 *
 * Must be called straight from a click: a `window.open` that browsers cannot
 * attribute to a user gesture is blocked outright.
 */
export async function requestAuthorization(request: AuthorizationRequest): Promise<Authorization> {
  const state = crypto.randomUUID()

  // Opened before anything is awaited. Any `await` first would break the gesture
  // attribution the pop-up blocker relies on.
  const popup = window.open(authorizationUrl(request, state), 'editor-cat-google', POPUP_FEATURES)
  if (!popup) {
    throw new ConsentDeclinedError(
      'The browser blocked the Google window. Allow pop-ups for this site and try again.',
    )
  }

  return await new Promise<Authorization>((resolve, reject) => {
    let timer = 0

    const finish = (fn: () => void) => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
      fn()
    }

    const onMessage = (event: MessageEvent) => {
      // The callback page is served from this origin, so anything else is not
      // the answer we are waiting for.
      if (event.origin !== window.location.origin) return

      const data = event.data as Partial<CallbackMessage> | null
      if (!data || data.source !== CALLBACK_MESSAGE) return
      // Ties this answer to this request, so a stale popup from an earlier
      // attempt cannot resolve the current one.
      if (data.state !== state) return

      finish(() => {
        popup.close()
        if (data.code) {
          resolve({ code: data.code })
        } else if (data.error === 'access_denied') {
          reject(new ConsentDeclinedError('Google access was declined.'))
        } else {
          reject(new Error(data.error || 'Google did not return an authorisation code.'))
        }
      })
    }

    window.addEventListener('message', onMessage)

    // Closing the window is how people cancel, and it fires no event of its own.
    timer = window.setInterval(() => {
      if (!popup.closed) return
      finish(() => {
        reject(new ConsentDeclinedError('The Google window was closed before finishing.'))
      })
    }, CLOSE_POLL_MS)
  })
}
