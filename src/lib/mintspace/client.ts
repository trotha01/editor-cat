/**
 * The Supabase client Mintspace is reached through.
 *
 * Deliberately a *second* client rather than the one in ../supabase/client.ts,
 * because the two are reached as two different people. The editor's own client
 * carries an Auth0 ID token, and Mintspace cannot make anything of it: its row
 * level security is written against `auth.uid()`, which casts the token's `sub`
 * to uuid, and Auth0 subjects look like `google-oauth2|104372…` — a cast that
 * fails outright rather than merely matching nothing. Its `profiles` table
 * references `auth.users` for the same reason. So publishing into Mintspace
 * means holding a Supabase Auth session for a Mintspace account: a second
 * identity, signed in to separately, and kept well away from the first.
 *
 * The two projects may or may not be the same project. Mintspace's schema is
 * built to share one — everything it owns is namespaced, tables under a
 * `mintspace` Postgres schema and storage under a bucket carrying the name —
 * so a deployment can point both sets of variables at one project or at two,
 * and nothing here needs to know which. What that does mean is that two clients
 * can end up on the same project ref, and supabase-js derives its default
 * session storage key from exactly that: hence the explicit `storageKey` below,
 * so the Mintspace session lives in a slot of its own either way.
 */
import { createClient } from '@supabase/supabase-js'

/**
 * Mintspace's tables live in their own Postgres schema; storage has no schemas,
 * so its bucket carries the name instead. Both must match the app's own
 * constants — see mintspace/src/lib/supabase.ts.
 */
export const MINTSPACE_SCHEMA = 'mintspace'
export const MINTSPACE_BUCKET = 'mintspace-videos'

function url(): string {
  return import.meta.env.VITE_MINTSPACE_SUPABASE_URL?.trim() ?? ''
}

function anonKey(): string {
  return import.meta.env.VITE_MINTSPACE_SUPABASE_ANON_KEY?.trim() ?? ''
}

/**
 * Where the Mintspace site itself is served from, if this deployment knows.
 *
 * Optional, and only ever used to offer a link after something is published.
 * The feed has no per-video route, so this is the site's front door rather than
 * a deep link; without it the success message links the uploaded file instead,
 * which is public and plays anywhere.
 */
export function mintspaceSiteUrl(): string {
  return import.meta.env.VITE_MINTSPACE_URL?.trim().replace(/\/+$/, '') ?? ''
}

/** Whether this deployment has a Mintspace project behind it. */
export function isMintspaceConfigured(): boolean {
  return url().length > 0 && anonKey().length > 0
}

function build() {
  return createClient(url(), anonKey(), {
    // `.from('videos')` and `.rpc('ensure_profile')` are both in here, and
    // neither resolves without this.
    db: { schema: MINTSPACE_SCHEMA },
    auth: {
      // Worth persisting: signing in to somewhere else in the middle of an
      // export is a tax, and one paid per export is a tax not worth paying.
      persistSession: true,
      autoRefreshToken: true,
      // This app's own sign-in is Auth0, whose redirect comes back with
      // `?code=&state=` on the URL. None of that is ever a Supabase session,
      // and there is nothing to gain from letting this client form an opinion
      // about it.
      detectSessionInUrl: false,
      storageKey: 'editor-cat.mintspace.auth',
    },
  })
}

/**
 * Typed off `build` rather than written out, because a client pinned to a
 * non-default schema carries that schema in its type — `SupabaseClient` on its
 * own means the `public` one, which this is not.
 */
export type MintspaceClient = ReturnType<typeof build>

let client: MintspaceClient | null = null

/**
 * Returns the shared Mintspace client, creating it on first use.
 *
 * Not created at module load, for the same reason the editor's own client is
 * not: `createClient` throws on an empty URL, and a deployment with no
 * Mintspace behind it still imports this file to ask whether there is one.
 */
export function mintspace(): MintspaceClient {
  if (!isMintspaceConfigured()) {
    throw new Error(
      'Mintspace is not configured for this site: set VITE_MINTSPACE_SUPABASE_URL and VITE_MINTSPACE_SUPABASE_ANON_KEY.',
    )
  }

  client ??= build()
  return client
}

/** Test seam: drop the cached client. */
export function resetForTests(): void {
  client = null
}
