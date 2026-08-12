/**
 * Signing in with Auth0, and asking it to hold the Drive grant.
 *
 * Auth0 is this site's account system and Google is the only way into it — a
 * social connection configured in the Auth0 dashboard, so the Google client id
 * and secret live there rather than in this repository. What the browser gets
 * back is an Auth0 session, and it is now the whole of the app's identity:
 * `/api/*` takes its access token, and Supabase — which registers this tenant as
 * a third-party auth provider — takes its ID token (see ../supabase/session.ts).
 *
 * Two asks, and the second one is the whole point. `beginGoogleSignIn`
 * establishes the account; `connectDrive` asks Google for the folder afterwards.
 * They are separate because of where Auth0 files what comes back: a login writes
 * the provider's tokens against the user's *identity*, and Token Vault — which
 * is what the functions exchange against — reads `connected_accounts`, a store
 * nothing but the connect flow fills. A login carrying `connection_scope` is
 * therefore not one screen saved but one grant wasted.
 *
 * Cheaper than it sounds, all the same. The address is known by the time the
 * second ask runs, so `login_hint` turns it into a single approval rather than
 * another choice of account — the same trick the old Netlify Identity flow
 * needed, for a different reason.
 *
 * A full-page redirect rather than a pop-up. There is no project open behind the
 * sign-in screen to navigate away from, and unlike Netlify Identity, Auth0
 * returns to the URL this app asks it to: previews at
 * `deploy-preview-32.example.com` come back to themselves, so long as the
 * matching wildcard is in the application's Allowed Callback URLs. That is what
 * makes deploy previews work without a registered redirect URI of their own, and
 * it is why nothing here relocates the browser between hosts.
 */
import { Auth0Client, type IdToken, type User } from '@auth0/auth0-spa-js'

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
  /** The API the access token is minted for — the one `/api/fal/*` verifies. */
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

/**
 * Raised when a renewal came back with an ID token that has already expired.
 *
 * Its own class because it is neither of the two failures around it: Auth0 was
 * reachable and it did not refuse, it simply answered with a credential nothing
 * downstream will accept. The only thing left that can be, from here, is a
 * session that has ended.
 */
export class Auth0IdTokenExpiredError extends Error {
  constructor() {
    super('Your session expired. Sign in again to continue.')
    this.name = 'Auth0IdTokenExpiredError'
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
    // One refresh token, two audiences: this app's API and Auth0's own
    // My Account API, which is where a Drive grant is filed. Without it the
    // silent exchange returns a token for the default audience and the connect
    // call below is refused by an API it was never addressed to — silently, in
    // the sense that the token looks perfectly valid. The tenant half is an MRRT
    // policy; see scripts/auth0-connect-setup.mjs.
    useMrrt: true,
    // Not optional. The My Account API declines bearer tokens and wants a proof
    // of possession bound to a key this browser generated, so a token lifted out
    // of storage cannot be replayed elsewhere. The SDK does the whole dance.
    useDpop: true,
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
 * Two errands come back through here and the SDK tells them apart by which code
 * is present: `code` is a sign-in, `connect_code` is a finished Drive grant.
 * Both are handed to the same `handleRedirectCallback`, which is why this only
 * has to recognise them, not sort them.
 *
 * Both parameters, not either: a code alone says nothing about who issued it,
 * and `state` alone appears on plenty of unrelated URLs.
 */
function isRedirectCallback(): boolean {
  const params = new URLSearchParams(window.location.search)
  return (
    (params.has('code') || params.has('connect_code') || params.has('error')) && params.has('state')
  )
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

    // Before reading the user, not after: `getUser` only looks in the cache —
    // it is a synchronous read dressed as a promise — and the cached token
    // expires in hours while the rotating refresh token behind it lasts weeks.
    // Without this, the first reload past the API's token lifetime reports
    // nobody signed in with a perfectly good refresh token sitting in storage,
    // which is most of what `useRefreshTokens` was turned on to prevent.
    //
    // `getTokenSilently` rather than `checkSession`, which gates on a cookie of
    // its own that expires a day after login and would reintroduce the same
    // cliff a little further out.
    try {
      await auth0().getTokenSilently()
    } catch {
      // Nobody signed in, or a refresh token that has genuinely run out. Both
      // leave the cache empty, `getUser` answers undefined, and the gate asks
      // for a sign-in — which is the right end for either.
    }

    account = toAccount(await auth0().getUser())
    return account
  })()

  return await adoption
}

/**
 * Sends the browser to Google, by way of Auth0. Nothing after this runs.
 *
 * Identity only. This asked for Drive too once, as a `connection_scope`, and the
 * consent screen duly showed the folder alongside the account — which worked,
 * and was useless, because of where Auth0 files what comes back.
 *
 * A login writes the provider's tokens to the user's *identity*. Token Vault
 * does not read identities; it reads `connected_accounts`, and nothing fills
 * that but the connect flow in `connectDrive` below. So a login carrying the
 * Drive scope produced an account holding a perfectly good Google refresh token
 * that the exchange could not see, and answered
 * `federated_connection_refresh_token_not_found` — a sentence about a missing
 * token, on behalf of a token that was right there.
 *
 * Asking here as well would therefore buy nothing and cost a screen: the user
 * would approve Drive twice, once into a store nobody reads.
 *
 * What is still deliberately *not* here is anything forcing a fresh Google
 * grant. `access_type` and `approval_prompt` are Google's parameters and Auth0
 * forwards them only as the connection's `upstream_params` — sent from here they
 * are worse than useless, because `access_type` is rejected outright by
 * `/authorize` and `prompt` is a standard OIDC parameter that Auth0 answers
 * itself, putting its own consent screen in front of the user rather than
 * passing anything on. See the README.
 */
export async function beginGoogleSignIn(): Promise<void> {
  await auth0().loginWithRedirect({
    authorizationParams: {
      connection: GOOGLE_CONNECTION,
      redirect_uri: window.location.origin,
    },
  })
}

/**
 * Asks Google for the Drive folder, on an account that is already signed in.
 *
 * The second screen, and the one that actually stocks Token Vault. Auth0 calls
 * this a connected account: the browser asks the My Account API to open a
 * consent, Google asks the user, and Auth0 keeps the refresh token that comes
 * back somewhere the token exchange in netlify/lib/tokenVault.ts can reach it.
 *
 * `login_hint` is what keeps it to a single click. The account is already known
 * by the time this runs, so Google is told which one rather than asked, and the
 * user sees the permission on its own instead of picking their address again —
 * the same trick the old Netlify Identity flow needed, for the same reason.
 *
 * Nothing after this runs: it navigates. The grant comes back as `connect_code`
 * on the next load, which `adoptRedirect` hands to the SDK along with everything
 * else.
 */
export async function connectDrive(loginHint?: string): Promise<void> {
  await auth0().connectAccountWithRedirect({
    connection: GOOGLE_CONNECTION,
    // The scope the *vault* is stocked with, which is the one the functions will
    // later spend. The connection carries the same list in the Auth0 dashboard;
    // naming it here too is what keeps the ask visible in the code that depends
    // on it.
    scopes: [...DRIVE_SCOPE_LIST],
    // Three naming conventions in one call, and they are the SDK's rather than
    // ours: `redirectUri` camel and top-level, `authorization_params` snake,
    // `login_hint` snake inside it. `loginWithRedirect` above spells the first
    // two the other way round.
    redirectUri: window.location.origin,
    ...(loginHint ? { authorization_params: { login_hint: loginHint } } : {}),
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
 * This is the token for `VITE_AUTH0_AUDIENCE` — this site's own API — and it is
 * what every call to `/api/*` carries: `/api/fal/*` verifies it against the
 * tenant's published keys (netlify/lib/auth.ts), and `/api/google/*` hands it
 * straight to Token Vault as the subject of the exchange. Supabase gets the ID
 * token instead; see `auth0IdToken` below for why they cannot be the same one.
 */
export async function auth0Token(): Promise<string | null> {
  if (!currentAccount()) return null
  return await auth0().getTokenSilently()
}

/**
 * How close to its own expiry an ID token is renewed rather than sent.
 *
 * PostgREST reads `exp` when the request arrives rather than when it left, so a
 * token with a second on it is a query that fails after the round trip.
 */
const ID_TOKEN_RENEW_WITHIN_SECONDS = 60

/**
 * Whether these claims have run out — optionally counting the next few seconds
 * as run out too.
 *
 * Claims with no `exp` count as current. Auth0 always sends one and the SDK
 * refuses a token without it, so this is the shape of an empty cache rather
 * than of a real token, and reading it as expired would put a forced network
 * refresh in front of every query on the page.
 */
function hasExpired(claims: IdToken | undefined, withinSeconds = 0): boolean {
  if (typeof claims?.exp !== 'number') return false
  return claims.exp - withinSeconds <= Math.floor(Date.now() / 1000)
}

/**
 * The raw ID token, which is the one Supabase accepts.
 *
 * PostgREST switches to the Postgres role named in the JWT's `role` claim, and
 * `authenticated` is what the row-level security policies are written against —
 * so a token without it reads the tables as `anon` and RLS refuses everything.
 * That claim has to be put there by an Auth0 Login Action, and Auth0 will only
 * carry it on the ID token: it silently strips custom claims from *access*
 * tokens unless they are namespaced, and a namespaced `role` is not the claim
 * PostgREST reads. Supabase's own Auth0 guide says the same thing and passes the
 * ID token for exactly this reason. See the README for the Action.
 *
 * The expiry check below is the whole reason this is not a one-liner, and it is
 * there because the obvious one-liner is wrong. `getIdTokenClaims` is a
 * synchronous read of the SDK's cache dressed as a promise, and
 * `getTokenSilently` renews on the *access* token's clock alone: auth0-spa-js
 * stores a cache entry's expiry as `now + expires_in` from the token response
 * and never consults the ID token's own `exp`, while the ID token it hands back
 * comes from a separate per-client entry that carries no expiry at all and is
 * only ever overwritten by a renewal that happens for some other reason.
 *
 * Auth0's defaults put ten hours on an ID token and twenty-four on an API
 * access token. For the fourteen hours between them the cached access token is
 * current, so no renewal runs, so the ID token beside it is never replaced —
 * and every Supabase query goes out with a credential that expired hours ago.
 * PostgREST answers `PGRST303 / "JWT expired"`, which is a sentence about a
 * database on behalf of a session that is perfectly alive.
 *
 * So the token actually being sent is the one whose expiry gets checked, and a
 * stale one is renewed with the cache turned off — the only way to make the SDK
 * spend the refresh token when its own bookkeeping sees nothing wrong.
 */
export async function auth0IdToken(): Promise<string | null> {
  if (!currentAccount()) return null

  // Still first, for what it covers on its own: a cache with nothing in it, and
  // a refresh token that has run out. The reject is how the second announces
  // itself, and the caller turns that into "sign in again".
  await auth0().getTokenSilently()

  let claims = await auth0().getIdTokenClaims()
  if (!hasExpired(claims, ID_TOKEN_RENEW_WITHIN_SECONDS)) return claims?.__raw ?? null

  await auth0().getTokenSilently({ cacheMode: 'off' })
  claims = await auth0().getIdTokenClaims()

  // Renewed and still past `exp`. Measured without the margin above, so a
  // tenant whose ID tokens are shorter-lived than the margin is not locked out
  // of a session that is working: this is the token Auth0 just minted, and only
  // a genuinely dead one is worth refusing to send.
  if (hasExpired(claims)) throw new Auth0IdTokenExpiredError()

  return claims?.__raw ?? null
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
