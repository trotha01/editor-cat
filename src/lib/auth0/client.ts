/**
 * Signing in with Auth0, which is also what authorises Drive.
 *
 * Auth0 is this site's account system and Google is the only way into it — a
 * social connection configured in the Auth0 dashboard, so the Google client id
 * and secret live there rather than in this repository. What the browser gets
 * back is an Auth0 access token, which `/api/session` trades for the Supabase
 * session the rest of the app carries (see ../supabase/session.ts).
 *
 * One screen, not two. The authorisation request names Drive as a
 * `connection_scope`, so the consent Google shows covers the account *and* the
 * folder, and Auth0 keeps the tokens that come back. Netlify Identity could not
 * do that — its login proved who someone was and nothing more, which is why
 * Drive used to be a second prompt — and getting back to one screen is most of
 * why this app is on Auth0 at all.
 *
 * A full-page redirect rather than a pop-up. There is no project open behind the
 * sign-in screen to navigate away from, and unlike Netlify Identity, Auth0
 * returns to the URL this app asks it to: previews at
 * `deploy-preview-32.example.com` come back to themselves, so long as the
 * matching wildcard is in the application's Allowed Callback URLs. That is what
 * makes deploy previews work without a registered redirect URI of their own, and
 * it is why nothing here relocates the browser between hosts.
 */
import { Auth0Client, type User } from '@auth0/auth0-spa-js'

/**
 * The connection Auth0 knows Google by. Fixed rather than configurable: it is
 * Auth0's own name for the Google social connection, the same in every tenant,
 * and the token exchange on the server side names it too.
 */
export const GOOGLE_CONNECTION = 'google-oauth2'

/**
 * The only Drive scope this app asks for, and deliberately the narrowest Google
 * offers: per-file access to what the app creates, plus whatever the user hands
 * it through the Picker.
 *
 * Asking for `drive.readonly` instead would mean "see and download all your
 * Google Drive files" on the consent screen, and a yearly third-party security
 * assessment before that screen could be published.
 *
 * Named here *and* configured on the Auth0 connection. The connection setting is
 * what Token Vault stores tokens against; this is what the authorisation request
 * asks for, which is what makes the ask visible in the code that depends on it.
 */
export const DRIVE_SCOPE_LIST: readonly string[] = ['https://www.googleapis.com/auth/drive.file']

export const DRIVE_SCOPES = DRIVE_SCOPE_LIST.join(' ')

export interface Auth0Config {
  domain: string
  clientId: string
  /** The API the access token is minted for — the one `/api/session` verifies. */
  audience: string
}

/** How this deployment reaches Auth0, or null when it was not built with any. */
export function auth0Config(): Auth0Config | null {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim().replace(/^https?:\/\//, '') ?? ''
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ?? ''
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim() ?? ''
  if (!domain || !clientId || !audience) return null
  return { domain, clientId, audience }
}

/** Whether this deployment can sign anyone in. Asked before the button is drawn. */
export function isAuth0Configured(): boolean {
  return auth0Config() !== null
}

/** Raised when the deployment was built without Auth0 settings. */
export class Auth0NotConfiguredError extends Error {
  constructor() {
    super('This site is not set up for sign-in: VITE_AUTH0_* are not configured.')
    this.name = 'Auth0NotConfiguredError'
  }
}

/**
 * Raised when Auth0 handed back a refusal rather than a session.
 *
 * Distinct from a thrown network error so the gate can tell "you declined" from
 * "something broke", and say the right one.
 */
export class Auth0RedirectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Auth0RedirectError'
  }
}

let client: Auth0Client | null = null

/** The shared client, created on first use. */
export function auth0(): Auth0Client {
  const config = auth0Config()
  if (!config) throw new Auth0NotConfiguredError()

  client ??= new Auth0Client({
    domain: config.domain,
    clientId: config.clientId,
    authorizationParams: {
      audience: config.audience,
      redirect_uri: window.location.origin,
    },
    // In memory would be lost on every reload, and this app is one people leave
    // open across tabs. The refresh token is rotating and the access token is
    // short-lived, which is what makes storage an acceptable trade here.
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
  })
  return client
}

/** The account this browser already has, or null. Populated by `adoptRedirect`. */
let account: Account | null = null

/** The signed-in account, as much of it as anything here needs to know. */
export interface Account {
  id: string
  email: string
}

function toAccount(user: User | undefined): Account | null {
  if (!user?.sub) return null
  return { id: user.sub, email: typeof user.email === 'string' ? user.email : '' }
}

/**
 * Whether this load is Auth0 returning from Google.
 *
 * Both parameters, not either: `code` alone is what the Drive consent used to
 * come back with, and `state` alone appears on plenty of unrelated URLs.
 */
function isRedirectCallback(): boolean {
  const params = new URLSearchParams(window.location.search)
  return (params.has('code') || params.has('error')) && params.has('state')
}

/**
 * The adoption in flight, so StrictMode's double mount reads the URL once.
 *
 * The query string can only be consumed once — the second call would find an
 * address bar this one has already cleaned and conclude nobody signed in.
 */
let adoption: Promise<Account | null> | null = null

/**
 * Completes a sign-in that Auth0 redirected back here, and restores one that was
 * already stored.
 *
 * Returns the account either way, so the caller does not have to know which of
 * the two happened.
 */
export async function adoptRedirect(): Promise<Account | null> {
  adoption ??= (async () => {
    if (!isAuth0Configured()) return null
    const params = new URLSearchParams(window.location.search)

    if (isRedirectCallback()) {
      // Taken out of the address bar whatever happens next: `code` is spent, and
      // a reload that replayed it would fail in a way that reads as a broken
      // sign-in rather than a stale URL.
      const error = params.get('error_description') ?? params.get('error')
      const clean = `${window.location.pathname}${window.location.hash}`

      if (error) {
        window.history.replaceState({}, '', clean)
        throw new Auth0RedirectError(error)
      }

      try {
        await auth0().handleRedirectCallback()
      } finally {
        window.history.replaceState({}, '', clean)
      }
    }

    account = toAccount(await auth0().getUser())
    return account
  })()

  return await adoption
}

/** Sends the browser to Google, by way of Auth0. Nothing after this runs. */
export async function beginGoogleSignIn(): Promise<void> {
  await auth0().loginWithRedirect({
    authorizationParams: {
      connection: GOOGLE_CONNECTION,
      // What makes this one screen rather than two: Google is asked for Drive at
      // the same time it is asked who this is.
      connection_scope: DRIVE_SCOPES,
      redirect_uri: window.location.origin,
    },
  })
}

/**
 * The account behind this page, without a round trip.
 *
 * Read straight after `adoptRedirect` has settled, which the auth store awaits
 * before anything else runs.
 */
export function currentAccount(): Account | null {
  return account
}

/**
 * A usable Auth0 access token, refreshed if it is close to expiring.
 *
 * Only `/api/session` is ever shown this. Everything else carries the Supabase
 * session minted from it.
 */
export async function auth0Token(): Promise<string | null> {
  if (!currentAccount()) return null
  return await auth0().getTokenSilently()
}

export async function auth0SignOut(): Promise<void> {
  account = null
  await auth0().logout({ logoutParams: { returnTo: window.location.origin } })
}

/** Test seam: drop the cached client, account and any consumed redirect. */
export function resetForTests(): void {
  client = null
  adoption = null
  account = null
}
