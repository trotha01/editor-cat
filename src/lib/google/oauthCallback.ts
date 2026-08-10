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
 * The answer arrives in the query string, which is where a code response goes.
 *
 * The fragment is read too, and costs one line. Google puts nothing there for
 * this flow, but a redirect that ever came back that way would otherwise look
 * like a consent that returned nothing at all.
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
    ...(value('error') ? { error: value('error') } : {}),
  }

  // Taken out of the address bar as soon as it has been read. The window is
  // about to close, but a blocked close would otherwise leave the code sitting
  // in a visible URL and in this window's session history.
  window.history.replaceState({}, '', window.location.pathname)

  // Written before the close attempt rather than only as a fallback: a browser
  // that refuses to close the window would otherwise leave a blank page, and
  // this is the one instruction that recovers every version of that — no
  // opener, a severed opener, or a close that did not happen.
  document.body.textContent =
    'You can close this window and return to editor-cat to finish connecting Google Drive.'

  if (!window.opener) return

  window.opener.postMessage(message, window.location.origin)
  window.close()
}
