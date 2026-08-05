/**
 * The pop-up side of the Google consent flow.
 *
 * Google redirects back to `/oauth/google`, which Netlify's SPA fallback serves
 * as this app. Nothing of the editor should mount there — it is a window that
 * exists for a few milliseconds — so main.tsx calls this first and stops if it
 * returns true.
 */
import { CALLBACK_MESSAGE, CALLBACK_PATH, type CallbackMessage } from './oauthPopup'

/** Whether this document is the consent pop-up rather than the app. */
export function isOauthCallback(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === CALLBACK_PATH
}

/**
 * Where the answer arrives depends on what was asked for.
 *
 * A bare code request comes back in the query string. The hybrid request — the
 * one that also carries an ID token — comes back in the fragment, because an ID
 * token must never be put somewhere a server could log it. Both are read, so
 * neither flow needs to know which it is.
 */
function responseParams(): URLSearchParams {
  const merged = new URLSearchParams(window.location.search)
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  for (const [key, value] of fragment) merged.set(key, value)
  return merged
}

/**
 * Hands the result back to the window that opened this one, and closes.
 *
 * The code goes over `postMessage` to this exact origin rather than being
 * exchanged here: the exchange needs the client secret, which only the Netlify
 * function has. An authorisation code is one-time and useless without that
 * secret, and is spent moments later by the opener.
 */
export function completeOauthCallback(): void {
  const params = responseParams()
  const value = (name: string) => params.get(name) ?? ''

  const message: CallbackMessage = {
    source: CALLBACK_MESSAGE,
    state: value('state'),
    ...(value('code') ? { code: value('code') } : {}),
    ...(value('id_token') ? { idToken: value('id_token') } : {}),
    ...(value('error') ? { error: value('error') } : {}),
  }

  if (window.opener) {
    window.opener.postMessage(message, window.location.origin)
    window.close()
    return
  }

  // No opener means someone reached this URL directly, or the browser severed
  // the relationship. There is nothing to hand the code to, so say so rather
  // than showing a blank page.
  document.body.textContent =
    'You can close this window and return to editor-cat to finish signing in.'
}
