/**
 * Who is signed in.
 *
 * Netlify Identity holds the account and Google is the only provider configured
 * for it, so signing in is a redirect out to Google and back. What returns is an
 * Identity session; the Supabase session the editor actually runs on is minted
 * from it on demand (see lib/supabase/session.ts), which is why nothing here
 * holds a token.
 *
 * Three ways the editor can be reachable, and the gate has to respect all of
 * them: a configured deployment requires a session; mock mode bypasses sign-in
 * so the end-to-end test and a keyless demo still work; and a checkout with no
 * Supabase project behind it stays purely local, which is what keeps `npm run
 * dev` usable straight after cloning.
 */
import { create } from 'zustand'
import {
  beginGoogleSignIn,
  consumeIdentityRedirect,
  currentIdentityUser,
  identitySignOut,
} from '../lib/netlify/identity'
import {
  clearSupabaseSession,
  SignInRequiredError,
  supabaseAccessToken,
} from '../lib/supabase/session'
import { isSupabaseConfigured } from '../lib/supabase/client'
import { isMockEnabled } from '../lib/mock'
import { toDisplayMessage } from '../lib/errors'

export type AuthStatus =
  /** No Supabase project, or mock mode: the editor is open and purely local. */
  'local' | 'checking' | 'signed-out' | 'signing-in' | 'signed-in'

/** Whether this build gates the editor behind a sign-in. */
export function requiresSignIn(): boolean {
  return isSupabaseConfigured() && !isMockEnabled()
}

/** The signed-in account, as much of it as anything here needs to know. */
export interface Account {
  id: string
  email: string
}

interface AuthState {
  status: AuthStatus
  account: Account | null
  error: string | null

  /** Adopts a redirect or a stored session. Call once on mount. */
  start: () => Promise<void>
  /** Leaves the page for Google, by way of Netlify Identity. */
  signIn: () => void
  signOut: () => Promise<void>
  setError: (message: string | null) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: requiresSignIn() ? 'checking' : 'local',
  account: null,
  error: null,

  start: async () => {
    if (!requiresSignIn()) return

    let user
    try {
      // A load that Google redirected back to carries the session in its
      // fragment; every other load reads the one already in storage.
      user = (await consumeIdentityRedirect()) ?? currentIdentityUser()
    } catch (cause) {
      set({ status: 'signed-out', account: null, error: toDisplayMessage(cause) })
      return
    }

    if (!user) {
      set({ status: 'signed-out', account: null })
      return
    }

    const account = { id: user.id, email: user.email }

    // Minting here rather than lazily is what catches an Identity session whose
    // refresh token has run out: it looks exactly like a valid stored session
    // until something asks it for a token. Better to find out now than to open
    // the editor and fail on the first save.
    try {
      await supabaseAccessToken()
    } catch (cause) {
      if (cause instanceof SignInRequiredError) {
        set({ status: 'signed-out', account: null })
        return
      }
      // Anything else is about the deployment rather than this session — the
      // signing secret is missing, or the function did not answer. Signing in
      // again would not help, so say so and let the gate show what it knows.
      set({ status: 'signed-in', account, error: toDisplayMessage(cause) })
      return
    }

    set({ status: 'signed-in', account, error: null })
  },

  signIn: () => {
    set({ status: 'signing-in', error: null })
    // Navigates away; nothing after this runs.
    beginGoogleSignIn()
  },

  signOut: async () => {
    // Dropped first, and unconditionally: it is a live credential for this
    // account's rows, and it must be gone whether or not the round trip to
    // Netlify succeeds.
    clearSupabaseSession()
    try {
      await identitySignOut()
    } catch (cause) {
      set({ error: toDisplayMessage(cause) })
    }
    set({ status: 'signed-out', account: null })
  },

  setError: (message) => set({ error: message }),
}))

/** Whether there is an account behind the current page. */
export function isSignedIn(): boolean {
  return useAuthStore.getState().account !== null
}
