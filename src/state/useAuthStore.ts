/**
 * Who is signed in.
 *
 * Three ways the editor can be reachable, and the gate has to respect all of
 * them: a configured deployment requires a session; mock mode bypasses sign-in
 * so the end-to-end test and a keyless demo still work; and a checkout with no
 * Supabase project behind it stays purely local, which is what keeps `npm run
 * dev` usable straight after cloning.
 */
import { create } from 'zustand'
import {
  currentSession,
  onAuthChange,
  signInWithGoogle,
  signOut,
  type Session,
} from '../lib/supabase/auth'
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

interface AuthState {
  status: AuthStatus
  session: Session | null
  error: string | null

  /** Restores a stored session and subscribes to changes. Call once on mount. */
  start: () => Promise<() => void>
  signIn: (idToken: string, nonce: string) => Promise<void>
  signOut: () => Promise<void>
  setError: (message: string | null) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: requiresSignIn() ? 'checking' : 'local',
  session: null,
  error: null,

  start: async () => {
    if (!requiresSignIn()) return () => {}

    // Subscribed before the restore so a token refresh landing mid-flight is
    // not missed.
    const unsubscribe = onAuthChange((session) => {
      set({ status: session ? 'signed-in' : 'signed-out', session })
    })

    try {
      const session = await currentSession()
      set({ status: session ? 'signed-in' : 'signed-out', session })
    } catch (cause) {
      set({ status: 'signed-out', error: toDisplayMessage(cause) })
    }

    return unsubscribe
  },

  signIn: async (idToken, nonce) => {
    set({ status: 'signing-in', error: null })
    try {
      const session = await signInWithGoogle(idToken, nonce)
      set({ status: 'signed-in', session })
    } catch (cause) {
      set({ status: 'signed-out', session: null, error: toDisplayMessage(cause) })
    }
  },

  signOut: async () => {
    try {
      await signOut()
    } catch (cause) {
      set({ error: toDisplayMessage(cause) })
    }
    set({ status: 'signed-out', session: null })
  },

  setError: (message) => set({ error: message }),
}))

/** The signed-in user's id, or null when running locally. */
export function currentUserId(): string | null {
  return useAuthStore.getState().session?.user.id ?? null
}

/**
 * The token proving to our own functions that this browser is signed in.
 *
 * Read per request rather than captured: a video job polls for minutes, and
 * Supabase refreshes the token underneath it. `onAuthChange` keeps the store
 * current, so reading it fresh each time is what keeps a long job from failing
 * halfway through on a token that was valid when it started.
 */
export function currentAccessToken(): string | null {
  return useAuthStore.getState().session?.access_token ?? null
}
