/**
 * Signing in with Google.
 *
 * There are two ways to do it here, and which one runs depends on whether the
 * deployment can store a Drive connection (see gis.ts):
 *
 * - **One screen for both** (`requestSignIn`). A single OAuth request asks for
 *   identity and Drive together and comes back with an ID token *and* a consent
 *   code. Supabase turns the first into a session; the second becomes a stored
 *   Drive connection. Nothing further is needed in Settings.
 *
 * - **Identity only** (`renderSignInButton`), for a deployment with nowhere to
 *   store a connection. This is Google Identity Services' `google.accounts.id`,
 *   which issues an ID token and cannot authorise Drive at all — so Drive stays
 *   a separate step in Settings, through `google.accounts.oauth2`.
 *
 * Mixing the two halves of GIS up is the easy mistake: `google.accounts.id`
 * issues an **ID token** saying who the user is, and `google.accounts.oauth2`
 * issues an **access token** granting Drive. Neither can do the other's job,
 * which is exactly why the combined flow does not use either.
 */
import { clientId, loadGisScript, SIGN_IN_SCOPES } from './gis'
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

/** Cleans up a rendered button so a re-render does not stack two of them. */
export type Rendered = () => void

/**
 * Draws Google's own sign-in button into `container` and resolves the ID token
 * when it is used.
 *
 * The rendered button is used rather than One Tap because One Tap is silently
 * suppressed for a user who has dismissed it a few times — leaving no way to
 * sign in at all, which is fatal for a gate.
 */
export async function renderSignInButton(
  container: HTMLElement,
  nonce: Nonce,
  onCredential: (idToken: string) => void,
  onError: (message: string) => void,
): Promise<Rendered> {
  const id = clientId()
  if (!id) {
    onError('Google sign-in is not configured for this site: VITE_GOOGLE_CLIENT_ID is not set.')
    return () => {}
  }

  try {
    await loadGisScript()
  } catch (cause) {
    onError(cause instanceof Error ? cause.message : String(cause))
    return () => {}
  }

  google.accounts.id.initialize({
    client_id: id,
    nonce: nonce.hashed,
    // The gate is the only way in, so a cancelled tap must leave the button
    // usable rather than blocking future prompts.
    cancel_on_tap_outside: false,
    callback: (response: google.accounts.id.CredentialResponse) => {
      if (response.credential) onCredential(response.credential)
      else onError('Google did not return a sign-in token. Try again.')
    },
  })

  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'filled_blue',
    size: 'large',
    text: 'signin_with',
    shape: 'pill',
    logo_alignment: 'left',
  })

  return () => {
    google.accounts.id.cancel()
    container.replaceChildren()
  }
}
