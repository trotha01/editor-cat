/**
 * Signing in with Google, which is also how Drive is authorised.
 *
 * One OAuth request asks for identity and Drive together and comes back with an
 * ID token *and* a consent code. Supabase turns the first into a session; the
 * second becomes the stored Drive connection. That is the only prompt this app
 * shows, and the only place it talks to Google.
 *
 * Deliberately not Google Identity Services. GIS splits the two jobs across
 * libraries that cannot do each other's — `google.accounts.id` issues an ID token
 * and cannot authorise Drive, `google.accounts.oauth2` authorises Drive and
 * cannot issue an ID token — so anything built on it asks the user twice.
 */
import { clientId, SIGN_IN_SCOPES } from './gis'
import { requestAuthorization } from './oauthPopup'

/**
 * A nonce ties one ID token to one sign-in attempt.
 *
 * Google signs the hash into the token; Supabase re-hashes the raw value and
 * compares. A token lifted from elsewhere therefore cannot be replayed into a
 * session here.
 */
export interface Nonce {
  /** Sent to Supabase. */
  raw: string
  /** Sent to Google. */
  hashed: string
}

export async function createNonce(): Promise<Nonce> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const raw = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hashed = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

  return { raw, hashed }
}

export interface SignInGrant {
  /** Proves who the user is. Exchanged with Supabase for a session. */
  idToken: string
  /** Becomes the stored Drive connection, once there is a session to file it under. */
  code: string
}

/**
 * Signs in and authorises Drive in one pass.
 *
 * `select_account` so the account in use is always a deliberate choice, and
 * `consent` because Google only issues a refresh token alongside a fresh grant —
 * without it a returning user would sign in fine and have no Drive connection
 * worth keeping.
 *
 * Must be called straight from a click, or the pop-up is blocked.
 */
export async function requestSignIn(nonce: Nonce): Promise<SignInGrant> {
  const id = clientId()
  if (!id) {
    throw new Error(
      'Google sign-in is not configured for this site: VITE_GOOGLE_CLIENT_ID is not set.',
    )
  }

  const result = await requestAuthorization({
    clientId: id,
    scope: SIGN_IN_SCOPES,
    nonce: nonce.hashed,
    prompt: 'select_account consent',
  })

  if (!result.idToken) throw new Error('Google did not return a sign-in token. Try again.')
  return { idToken: result.idToken, code: result.code }
}
