/**
 * Turning a Google ID token into a Supabase session.
 *
 * No OAuth redirect is involved: the page obtains a signed ID token from Google
 * in place (see lib/google/identity.ts) and hands it to Supabase, which
 * verifies the signature and issues its own session. That keeps sign-in from
 * navigating away mid-edit, and means the one Google account covers both
 * identity here and Drive authorisation.
 */
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './client'

export type { Session, User }

/** Exchanges a Google ID token for a Supabase session. */
export async function signInWithGoogle(idToken: string, nonce: string): Promise<Session> {
  const { data, error } = await supabase().auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
    nonce,
  })

  if (error) throw new Error(describeAuthError(error.message))
  if (!data.session) throw new Error('Google sign-in did not return a session. Try again.')
  return data.session
}

export async function signOut(): Promise<void> {
  const { error } = await supabase().auth.signOut()
  if (error) throw new Error(error.message)
}

/** The session restored from storage, if the user is already signed in. */
export async function currentSession(): Promise<Session | null> {
  const { data } = await supabase().auth.getSession()
  return data.session
}

/** Fires on sign-in, sign-out, and token refresh. Returns an unsubscribe. */
export function onAuthChange(fn: (session: Session | null) => void): () => void {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => fn(session))
  return () => data.subscription.unsubscribe()
}

/**
 * Rewrites the failure that a misconfiguration actually produces.
 *
 * The client ID has to be registered in two places — the Google console and
 * Supabase's Google provider — and a mismatch surfaces as a bare "Unacceptable
 * audience", which points at nothing.
 */
function describeAuthError(message: string): string {
  const lowered = message.toLowerCase()
  if (lowered.includes('audience') || lowered.includes('client')) {
    return `${message} — this usually means the Google client ID is missing from Supabase: add it under Authentication → Providers → Google → Authorized Client IDs.`
  }
  if (lowered.includes('nonce')) {
    return `${message} — the sign-in attempt expired. Try again.`
  }
  return message
}
