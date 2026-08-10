/**
 * The pop-up side of the Google consent flow.
 *
 * Google redirects back to `/oauth/google`, which Netlify's SPA fallback serves
 * as this app. Nothing of the editor should mount there — it is a window that
 * exists for a few milliseconds — so main.tsx calls this first and stops if it
 * returns true.
 *
 * This window does not necessarily belong to the deploy that opened it. One
 * origin is registered with Google so that every preview can share it (see
 * `callbackOrigin` in oauthPopup.ts), which means the answer usually has to
 * cross back to a different host — and deciding which hosts may receive it is
 * the job this file picked up in exchange.
 */
import { CALLBACK_PATH } from './callbackPath'
import { CALLBACK_MESSAGE, openerOrigin, type CallbackMessage } from './oauthPopup'

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
 * The domain suffix whose deploys may be handed a code, with its leading dot.
 *
 * The dot is the whole point of normalising it: `endsWith('staging.example')`
 * also accepts `not-staging.example`, which belongs to somebody else.
 */
function allowedSuffix(): string | null {
  const raw = import.meta.env.VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX?.trim().toLowerCase()
  if (!raw) return null
  const bare = raw.replace(/^\.+/, '').replace(/\.+$/, '')
  return bare ? `.${bare}` : null
}

/**
 * Whether this window may hand its answer to `origin`.
 *
 * Registering one redirect URI for every deploy means the answer travels back to
 * an origin named in `state` — and `state` arrives as a query parameter, so it
 * says whatever the URL that opened this window said it should. Anyone can build
 * an authorisation URL naming a site of their own. Google's byte-for-byte
 * matching of redirect URIs used to make that impossible; taking one URI in its
 * place means taking on the check it was performing.
 *
 * Hence a suffix the operator sets, covering the deploy subdomains they control
 * and nothing else. This window's own origin is always allowed, which is what a
 * site with one URL and `netlify dev` both rely on — so leaving the suffix unset
 * opens nothing up, it refuses everything else.
 */
export function isAllowedOpenerOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true

  const suffix = allowedSuffix()
  if (!suffix) return false

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // `new URL` accepts far more than an origin. Anything carrying a path, a query
  // or credentials is not one, and comparing back is the cheapest way to say so.
  if (url.origin !== origin) return false
  // A code handed to `http://` is a code handed to whoever is on the path.
  if (url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  return host === suffix.slice(1) || host.endsWith(suffix)
}

/**
 * Hands the result back to the window that opened this one, and closes.
 *
 * The code goes over `postMessage` to one named origin rather than being
 * exchanged here: the exchange needs the client secret, which only the Netlify
 * function has. An authorisation code is one-time and useless without that
 * secret, and is spent moments later by the opener.
 *
 * `targetOrigin` is never `'*'`. It is the whole protection on a message that
 * carries a code someone else could spend, and the browser refuses to deliver it
 * anywhere else — which is also what makes a stale opener fail closed rather
 * than quietly.
 */
export function completeOauthCallback(): void {
  const params = responseParams()
  const value = (name: string) => params.get(name) ?? ''

  const state = value('state')
  const message: CallbackMessage = {
    source: CALLBACK_MESSAGE,
    state,
    ...(value('code') ? { code: value('code') } : {}),
    ...(value('error') ? { error: value('error') } : {}),
  }

  // Taken out of the address bar as soon as it has been read. The window is
  // about to close, but a blocked close would otherwise leave the code sitting
  // in a visible URL and in this window's session history.
  window.history.replaceState({}, '', window.location.pathname)

  // A `state` with no origin in it is one this deploy sent before the answer
  // learned to travel — its opener is this same origin, as it always was.
  const target = openerOrigin(state) ?? window.location.origin
  const allowed = isAllowedOpenerOrigin(target)

  // Written before the close attempt rather than only as a fallback: a browser
  // that refuses to close the window would otherwise leave a blank page, and
  // this is the one instruction that recovers every version of that — no
  // opener, a severed opener, or a close that did not happen.
  //
  // The refusal names the origin because the only person who ever reads it is
  // whoever has to go and fix the suffix it failed against.
  document.body.textContent = allowed
    ? 'You can close this window and return to editor-cat to finish connecting Google Drive.'
    : `This site will not send a Google authorisation to ${target}. Close this window and connect Drive from the site you signed in to.`

  // Left open on a refusal: closing it would take the reason with it.
  if (!allowed) return
  if (!window.opener) return

  window.opener.postMessage(message, target)
  window.close()
}
