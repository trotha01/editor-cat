/**
 * The Supabase client.
 *
 * The anon key is public by design — it identifies the project, and row-level
 * security is what actually protects the data. Every table this app touches has
 * RLS enabled with an `auth.uid() = user_id` policy, so a token is the only
 * thing that grants access to a row.
 *
 * That token does not come from Supabase Auth. Sign-in is Netlify Identity, and
 * `accessToken` hands the client the session minted from it — the third-party
 * auth seam supabase-js provides for exactly this, and the reason none of the
 * query code above had to learn where identity comes from. Setting it takes the
 * `auth` namespace out of use, which is correct: this project has no Supabase
 * Auth users to sign in, out, or refresh.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseAccessToken } from './session'

function url(): string {
  return import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
}

function anonKey(): string {
  return import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''
}

/** Whether this deployment has a Supabase project behind it. */
export function isSupabaseConfigured(): boolean {
  return url().length > 0 && anonKey().length > 0
}

let client: SupabaseClient | null = null

/**
 * Returns the shared client, creating it on first use.
 *
 * Deliberately not created at module load: an unconfigured checkout imports
 * this file through the store graph, and `createClient` throws on an empty URL.
 */
export function supabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured for this site: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }

  client ??= createClient(url(), anonKey(), {
    // Called per request rather than captured, so a session renewed mid-edit is
    // picked up without rebuilding the client. See session.ts for the caching
    // that keeps this from becoming a request of its own each time.
    accessToken: supabaseAccessToken,
  })
  return client
}

/** Test seam: drop the cached client. */
export function resetForTests(): void {
  client = null
}
