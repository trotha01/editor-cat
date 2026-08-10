/**
 * The token the Supabase client carries.
 *
 * There used to be a mint here. Supabase would not accept an Auth0 token, so
 * `/api/session` verified one and signed a Supabase-shaped session with the
 * project's own secret, and this module asked for those, held them, and asked
 * again before they ran out. All of that is gone: the Supabase project now
 * registers Auth0 as a third-party auth provider, so PostgREST validates the
 * Auth0 token against the tenant's own published keys and there is nothing left
 * to convert. What survives is the one decision the mint was wrapped around —
 * which token to hand over, and what to do when there is none.
 *
 * It is the *ID* token rather than the access token. Only the ID token can carry
 * the unnamespaced `role: authenticated` claim that PostgREST switches roles on;
 * see auth0IdToken in ../auth0/client.ts. The access token is still what this
 * site's own functions take, so both are in play — they are simply not
 * interchangeable, and handing PostgREST the wrong one reads the tables as
 * `anon`.
 *
 * No caching either, for the same reason the mint is gone: auth0-spa-js already
 * holds the session and refreshes it, so supabase-js calling this per request
 * costs a cache read rather than a round trip. The old shared-attempt machinery
 * existed to keep a burst of concurrent queries from firing a burst of identical
 * mints; with nothing to mint, the SDK's own de-duplication is the whole of it.
 */
import { auth0IdToken, currentAccount } from '../auth0/client'

/** Raised when there is no Auth0 session behind the request any more. */
export class SignInRequiredError extends Error {
  constructor(message = 'Sign in again to continue.') {
    super(message)
    this.name = 'SignInRequiredError'
  }
}

/**
 * The token supabase-js should send, or null when nobody is signed in.
 *
 * Null rather than a throw for the signed-out case: that is the ordinary state
 * of a page nobody has signed into, and supabase-js reads it as "send the anon
 * key alone" — which row-level security then refuses, which is the correct
 * outcome. Throwing there would turn every background query on a signed-out tab
 * into an error someone has to handle.
 *
 * A session that has genuinely run out is a different thing and does throw:
 * auth0-spa-js rejects rather than returning null when a silent refresh is
 * refused, and that is the shape an expired refresh token arrives in.
 */
export async function supabaseAccessToken(): Promise<string | null> {
  if (!currentAccount()) return null

  try {
    return await auth0IdToken()
  } catch {
    throw new SignInRequiredError()
  }
}
