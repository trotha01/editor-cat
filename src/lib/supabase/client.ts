/**
 * The Supabase client.
 *
 * The anon key is public by design — it identifies the project, and row-level
 * security is what actually protects the data. Every table this app touches has
 * RLS enabled with an `auth.uid() = user_id` policy, so a token is the only
 * thing that grants access to a row.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

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
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth redirect lands back here — sign-in hands Supabase a Google ID
      // token from the page itself — so there is never a session in the URL.
      detectSessionInUrl: false,
    },
  })
  return client
}

/** Test seam: drop the cached client. */
export function resetForTests(): void {
  client = null
}
