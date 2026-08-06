/**
 * Which Supabase project this deployment belongs to.
 *
 * Its own module because two of them need the answer — `auth.ts` to know whose
 * sessions to trust, `googleConnections.ts` to know which database holds the
 * refresh tokens — and if they read it from different variables they disagree
 * about whether the site is configured at all. That disagreement is not
 * hypothetical: it shipped, and what it looked like from a browser was a site
 * that let you sign in, took your Google consent, and then answered 503 to the
 * request that would have saved it.
 */

/**
 * The project URL, or an empty string when this deployment has not been told.
 *
 * The unprefixed name wins so an operator can override the build-time one, but
 * the build-time name is accepted because the project URL is not a secret: it is
 * compiled into the browser bundle already, since the client has to connect to
 * it. Requiring the same public string under a second name buys nothing and
 * costs exactly the class of misconfiguration described above.
 *
 * That reasoning covers the URL and nothing else. `SUPABASE_JWT_SECRET` and
 * `SUPABASE_SERVICE_ROLE_KEY` have no `VITE_` fallback and must never gain one —
 * a `VITE_` prefix inlines a value into the bundle, and for those two that would
 * publish the keys to every account on the site.
 *
 * The trailing slash is easy to leave on a pasted URL, and would otherwise break
 * both the `iss` comparison and every PostgREST path built from it.
 */
export function supabaseProjectUrl(): string {
  return (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
}
