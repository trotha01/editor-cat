/**
 * Signing in with Netlify Identity.
 *
 * Identity is this site's account system, and Google is the only way into it —
 * an external provider configured in the Netlify dashboard, so the client id and
 * secret for it live there rather than in this repository. What the browser gets
 * back is an Identity token, which `/api/session` trades for the Supabase
 * session the rest of the app carries (see ../supabase/session.ts).
 *
 * `gotrue-js` rather than the Identity widget. The widget is a pre-built modal
 * that renders in an iframe with styling of its own, and this app already has a
 * sign-in screen written to match the editor behind it; the library underneath
 * the widget does the parts that are actually hard — holding the session,
 * refreshing the token before it expires — and leaves the pixels alone. It also
 * keeps the site's Content-Security-Policy as tight as it is: nothing new is
 * framed, and every request goes to this origin.
 *
 * Google's consent is reached by a full-page redirect rather than the pop-up
 * used for Drive, because Netlify Identity chooses where it returns to and that
 * is the site root. There is no project open behind the sign-in screen to
 * navigate away from, so nothing is lost by leaving.
 */
import GoTrue, { type User } from 'gotrue-js'

/**
 * Where this site's Identity instance lives.
 *
 * Same origin by default: Netlify serves Identity from `/.netlify/identity` on
 * the site itself. The override exists for `npm run dev`, which serves the app
 * on :5173 with no Netlify behind it — point it at a deployed site and sign-in
 * works locally. `netlify dev` needs no override, because it proxies Identity.
 */
export function identityApiUrl(): string {
  const configured = import.meta.env.VITE_NETLIFY_IDENTITY_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `${window.location.origin}/.netlify/identity`
}

let client: GoTrue | null = null

/** The shared GoTrue client, created on first use. */
export function identity(): GoTrue {
  client ??= new GoTrue({
    APIUrl: identityApiUrl(),
    // Identity's own audience handling; empty is what the widget sends too.
    audience: '',
    // The session is kept in localStorage by gotrue-js, which is what survives a
    // reload. A cookie would additionally be sent to our own functions on every
    // request for a stylesheet, which nothing here wants.
    setCookie: false,
  })
  return client
}

export type { User as IdentityUser }

/**
 * Raised when Google handed back a refusal rather than a session.
 *
 * Distinct from a thrown network error so the gate can tell "you declined" from
 * "something broke", and say the right one.
 */
export class IdentityRedirectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRedirectError'
  }
}

interface HashTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: 'bearer'
}

/**
 * Reads what Identity left in the fragment, and takes it out of the address bar.
 *
 * The fragment is where it has to arrive — a token in the query string would be
 * logged by every proxy between here and the browser — and it has to leave
 * again immediately, because a reload would otherwise replay it and it would sit
 * in this tab's history in the meantime.
 */
function readRedirectFragment(): HashTokens | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))

  const error = params.get('error_description') ?? params.get('error')
  const accessToken = params.get('access_token')
  if (!error && !accessToken) return null

  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)

  if (error) throw new IdentityRedirectError(error)

  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) {
    throw new IdentityRedirectError('Netlify Identity returned an incomplete sign-in. Try again.')
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: Number(params.get('expires_in')) || 3600,
    token_type: 'bearer',
  }
}

/**
 * The redirect being adopted, or the fact that there was none.
 *
 * Memoised because StrictMode mounts the gate twice in development and the
 * fragment can only be read once — the second call would find an address bar
 * this one has already cleaned and conclude nobody signed in.
 */
let adoption: Promise<User | null> | null = null

/** Completes a sign-in that Google redirected back here, if this load is one. */
export async function consumeIdentityRedirect(): Promise<User | null> {
  adoption ??= (async () => {
    const tokens = readRedirectFragment()
    if (!tokens) return null
    // `true` remembers the session, which is what makes it survive a reload —
    // and the redirect flow has no other way to get the user back afterwards.
    return await identity().createUser({ ...tokens, expires_at: 0 }, true)
  })()

  return await adoption
}

/** Sends the browser to Google, by way of Netlify Identity. */
export function beginGoogleSignIn(): void {
  window.location.assign(identity().loginExternalUrl('google'))
}

/** The user this browser already has, restored from storage. */
export function currentIdentityUser(): User | null {
  return identity().currentUser()
}

/**
 * A usable Identity token, refreshed if it is close to expiring.
 *
 * Only `/api/session` is ever shown this. Everything else carries the Supabase
 * session minted from it.
 */
export async function identityToken(): Promise<string | null> {
  const user = currentIdentityUser()
  if (!user) return null
  return await user.jwt()
}

export async function identitySignOut(): Promise<void> {
  const user = currentIdentityUser()
  // `logout` clears the stored session even when the round trip fails, which is
  // the half that actually matters on the way out.
  if (user) await user.logout()
}

/**
 * Whether this deployment can sign anyone in, and with Google specifically.
 *
 * Asked before the button is drawn. A site whose Identity is switched off, or
 * which has Google unticked in the dashboard, would otherwise send someone to a
 * redirect that dead-ends — and the reason is something only an operator can
 * act on, so it is worth naming rather than discovering after a click.
 */
export async function identityGoogleEnabled(): Promise<boolean> {
  try {
    const settings = await identity().settings()
    return settings.external?.google === true
  } catch {
    // No Identity on this site: the path 404s, or the SPA fallback answers with
    // index.html, which does not parse as settings either.
    return false
  }
}

/** Test seam: drop the cached client and any consumed redirect. */
export function resetForTests(): void {
  client = null
  adoption = null
}
