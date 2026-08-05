/**
 * Google sign-in for identity, as opposed to Drive authorisation.
 *
 * Two different halves of Google Identity Services are in play, and mixing them
 * up is the easy mistake here:
 *
 * - `google.accounts.id` (this file) issues an **ID token** — a signed JWT
 *   saying who the user is. That is what Supabase verifies to create a session.
 * - `google.accounts.oauth2` (gis.ts) issues an **access token** — permission
 *   to call Drive. It cannot produce an ID token.
 *
 * Both ride the same Google session, so choosing an account once covers both.
 */
import { clientId, loadGisScript } from './gis'

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
