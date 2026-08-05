/**
 * The popup side of the Drive consent flow.
 *
 * Google redirects back to `/oauth/google?code=…`, which Netlify's SPA fallback
 * serves as this app. Nothing of the editor should mount there — it is a window
 * that exists for a few milliseconds — so main.tsx calls this first and stops if
 * it returns true.
 */
import { CALLBACK_MESSAGE, CALLBACK_PATH, type CallbackMessage } from './oauthPopup'

/** Whether this document is the consent popup rather than the app. */
export function isOauthCallback(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === CALLBACK_PATH
}

/**
 * Hands the authorisation code back to the window that opened this one, and
 * closes.
 *
 * The code goes over `postMessage` to this exact origin rather than being
 * exchanged here: the exchange needs the client secret, which only the Netlify
 * function has. Nothing sensitive is in the URL — an authorisation code is
 * one-time, useless without the secret, and spent moments later by the opener.
 */
export function completeOauthCallback(): void {
  const params = new URLSearchParams(window.location.search)

  const message: CallbackMessage = {
    source: CALLBACK_MESSAGE,
    state: params.get('state') ?? '',
    ...(params.get('code') ? { code: params.get('code') as string } : {}),
    ...(params.get('error') ? { error: params.get('error') as string } : {}),
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
    'You can close this window and return to editor-cat to finish connecting Google Drive.'
}
