/**
 * Who is signed in.
 *
 * Auth0 holds the account and Google is the only connection configured for it,
 * so signing in is a redirect out to Google and back. What returns is an Auth0
 * session, and that session is now the whole of it: Supabase trusts Auth0
 * directly as a third-party auth provider, so the editor runs on the Auth0 ID
 * token rather than on anything this site signs (see lib/supabase/session.ts).
 * Nothing here holds a token — auth0-spa-js is the only thing that does.
 *
 * Three ways the editor can be reachable, and the gate has to respect all of
 * them: a configured deployment requires a session; mock mode bypasses sign-in
 * so the end-to-end test and a keyless demo still work; and a checkout with no
 * Supabase project behind it stays purely local, which is what keeps `npm run
 * dev` usable straight after cloning.
 */
import { create } from 'zustand'
import { adoptRedirect, auth0SignOut, beginGoogleSignIn, type Account } from '../lib/auth0/client'
import { SignInRequiredError, supabaseAccessToken } from '../lib/supabase/session'
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

export type { Account }

interface AuthState {
  status: AuthStatus
  account: Account | null
  error: string | null

  /** Adopts a redirect or a stored session. Call once on mount. */
  start: () => Promise<void>
  /** Leaves the page for Google, by way of Auth0. */
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

    let account: Account | null
    try {
      // A load that Auth0 redirected back to carries `code` and `state` in its
      // query string; every other load reads the session already in storage.
      // One call covers both.
      account = await adoptRedirect()
    } catch (cause) {
      set({ status: 'signed-out', account: null, error: toDisplayMessage(cause) })
      return
    }

    if (!account) {
      set({ status: 'signed-out', account: null })
      return
    }

    // Asking for the token here rather than lazily is what catches an Auth0
    // session whose refresh token has run out: it looks exactly like a valid
    // stored session until something asks it for one. Better to find out now
    // than to open the editor and fail on the first save.
    //
    // It survived the end of the mint because that is not what it was for. The
    // call is a silent refresh either way, and the refresh is what fails.
    try {
      await supabaseAccessToken()
    } catch (cause) {
      if (cause instanceof SignInRequiredError) {
        set({ status: 'signed-out', account: null })
        return
      }
      // Nothing else is expected here now that no server has to answer for a
      // token to exist. Kept anyway: an unforeseen failure should reach the gate
      // as something it can show, not as an unhandled rejection.
      set({ status: 'signed-in', account, error: toDisplayMessage(cause) })
      return
    }

    set({ status: 'signed-in', account, error: null })
  },

  signIn: () => {
    set({ status: 'signing-in', error: null })
    // Navigates away, so nothing after it runs — but the navigation is awaited
    // inside the SDK, and a rejection before it happens would otherwise leave
    // the gate spinning at `signing-in` with nothing to show.
    void beginGoogleSignIn().catch((cause: unknown) => {
      set({ status: 'signed-out', error: toDisplayMessage(cause) })
    })
  },

  signOut: async () => {
    // There is nothing to drop here any more. This used to clear the minted
    // Supabase session first and unconditionally, because it was a live
    // credential this module was the only holder of. The credential is now the
    // Auth0 ID token, which auth0-spa-js keeps and `auth0SignOut` clears along
    // with everything else in its cache — so a second seam here would only be
    // able to go stale.
    try {
      // Navigates away to Auth0's logout endpoint and back, which is what ends
      // the session there as well as here.
      await auth0SignOut()
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
