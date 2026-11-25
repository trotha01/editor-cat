Signing in worked; every Supabase REST call failed. `GET /rest/v1/projects?select=...` came back with:

```json
{
  "code": "PGRST301",
  "details": "None of the keys was able to decode the JWT",
  "message": "No suitable key or wrong key type"
}
```

`useProjectsStore.start()` threw out of `listProjects()` into its catch and set `status: 'error'`, so the project list was empty, the sync badge read "Not saved", and nothing saved.

## Why HS256 could not work against that project

Not a wrong secret — a key type the project has no way to verify. `netlify/lib/supabaseToken.ts` signed `alg: 'HS256'`, an HMAC over `SUPABASE_JWT_SECRET`. The project publishes exactly one signing key, and it is asymmetric:

```
$ curl https://dxfxvvrbltjckstlnhup.supabase.co/auth/v1/.well-known/jwks.json
{"keys":[{"alg":"ES256","crv":"P-256","kty":"EC","use":"sig",
          "kid":"91d87bf4-34e2-4fb5-aec4-509d2e3259b9", ...}]}
```

One EC P-256 key, no symmetric (`oct`) key. PostgREST had nothing that could check an HMAC, which is precisely what "no suitable key or wrong key type" reports. Re-enabling a legacy shared secret would have papered over it.

## What replaces it

Auth0 is registered on the Supabase project as a **third-party auth provider**, and the browser hands supabase-js the Auth0 token directly for PostgREST to validate against the tenant's own published keys. The comment at `netlify/lib/supabaseToken.ts:14` noted the mint was shaped after this; this replaces the imitation with the real thing.

**It is the ID token, not the access token.** This is the one place I diverged from the issue as written, and it is deliberate. PostgREST switches to the Postgres role named in an unnamespaced `role` claim, and Auth0 silently strips unnamespaced custom claims from *access* tokens — so `api.accessToken.setCustomClaim('role', 'authenticated')` does not work. Supabase's own Auth0 guide says exactly this and passes the ID token for the same reason:

> Auth0 silently strips non-namespaced custom claims from access tokens, so `api.accessToken.setCustomClaim('role', 'authenticated')` does not work. Use `api.idToken.setCustomClaim` and pass the ID token to Supabase.

A namespaced claim would survive the access token, but `https://example.com/role` is not the claim PostgREST reads. So there are two Auth0 tokens in play and they are not interchangeable — `auth0IdToken()` for Supabase, `auth0Token()` for this site's own functions, which check `aud` against this site's API. Sending the wrong one fails silently: it verifies, reads as `anon`, and returns an empty project list. `src/lib/falClient.test.ts` and `src/lib/supabase/session.test.ts` now pin each one.

**Functions.** `requireSession()` verifies the Auth0 access token through `netlify/lib/auth0.ts` rather than a second verifier of its own — same signature, issuer, audience and expiry checks that were already there. Verification stays local: one video generation polls for minutes, and the JWKS cache is what keeps a round trip out of every poll.

Two hardening fixes fell out of routing the unauthenticated `/api/fal/*` through that verifier:

- The forced JWKS refetch on an unrecognised `kid` is now rate-limited to once per five minutes. `kid` is read from an unverified header on a request that need not carry a usable token, so unbounded it was an amplifier pointed at Auth0's rate limit — a loop of tokens naming random key ids becomes a 429, and then 502s for everyone holding a real token. A rotation is still picked up within five minutes without a deploy.
- A signature segment that is not base64url raised out of `atob`, left the module as a thrown error, and surfaced as `502 "Could not check who you are just now"` — telling someone to wait out an outage over a token that is merely malformed. It answers 401 now, as the old verifier did.

**Deleted.** `netlify/functions/session.ts`, `netlify/lib/supabaseToken.ts`, and every reference to `SUPABASE_JWT_SECRET`. `netlify/lib/supabase.ts` went too: `/api/session` was its only consumer, and nothing server-side talks to Supabase any more.

**The sign-in gate.** `sessionReadiness()` was a `GET /api/session` before the gate would draw a button, so a site missing its config said so rather than sending someone through Google's consent screen to nowhere. That endpoint is gone, and what it was checking for — a secret only the functions could see — no longer exists. The gate now asks `isAuth0Configured()` locally and answers on the first render, with no round trip and no spinner. The Supabase half needs no check: `requiresSignIn()` is what puts the screen on the page and is false without a project URL and anon key, so that deployment opens the editor in local-only mode instead. `src/components/SignInGate.test.tsx` is updated rather than deleted, and still proves the gate will not offer a sign-in the deployment cannot honour.

## What an operator must do by hand before this deploys

None of this is in the repository, and the change does not work without it. Full detail is in the README under "What sign-in needs".

1. **Supabase dashboard → Authentication → Third-Party Auth → Add integration → Auth0**, with the tenant ID (and region, where asked). That is what points PostgREST at `https://<tenant>/.well-known/jwks.json`.
2. **Auth0 → Actions → Triggers → post-login**, an action containing exactly this, dragged into the Login flow and deployed:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.idToken.setCustomClaim('role', 'authenticated')
   }
   ```
   `idToken`, not `accessToken` — see above. Without the claim PostgREST reads the tables as `anon`.
3. **The access token's `aud` must include `VITE_AUTH0_AUDIENCE`.** The SPA already asks for it; it is what `/api/fal/*` checks before attaching the fal key. Wrong or absent, sign-in and saving work and generation answers 401.
4. **Remove `SUPABASE_JWT_SECRET` from the Netlify environment.** Nothing reads it, and it can mint a session as anybody.

## Why the migration is numbered 0006

`0005_project_drive_folder.sql` is taken by #28, which adds a `drive_folder_id` column and has already been applied to the live project. Numbering around it means neither branch has to be renumbered whichever merges first. The two are independent — one adds a column, the other changes a type and rewrites policies — so they apply in either order. The reserved gap is noted in the SQL comment so the next reader does not think a file is missing.

Fixing the signature alone would have got one error further, not to working. `auth.uid()` is `(request.jwt.claims ->> 'sub')::uuid` and Auth0 subjects are not UUIDs — `netlify/lib/auth0.ts:241` returns `payload.sub` verbatim, which looks like `google-oauth2|104372…`. Both tables were `user_id uuid` with `using (auth.uid() = user_id)`, so the moment the JWT verified, every query would raise `22P02 invalid input syntax for type uuid`. `0006` changes both columns to `text`, moves the defaults and policies onto `auth.jwt() ->> 'sub'`, and leaves `projects_user_updated` and the `assets` composite primary key to be rebuilt by the same `ALTER` statement.

**It also repeats `0003`'s two foreign-key drops**, which is not belt and braces. `0001` declared `user_id ... references auth.users (id)`, `ALTER COLUMN ... TYPE` rebuilds every constraint on the column, and a text column referencing a uuid one has no equality operator — so with `0003` outstanding the migration aborts with `foreign key constraint "projects_user_id_fkey" cannot be implemented`. `0003` *is* outstanding on the live project, so without the repeat this file would have failed on the one database it was written for.

I verified the migration against a real PostgreSQL 16 rather than reasoning about it: a clean `0001→0006` run, an out-of-order run with `0003` outstanding, a second application of `0006` (re-runnable), RLS isolation between two Auth0 subjects, the `with check` refusing a row written onto another account, an anonymous request seeing nothing, and both indexes surviving with the right definitions. I also confirmed the counterfactual — with the foreign-key drops removed, it fails exactly as described.

### What happens to rows written under the old user ids

They survive the migration and become **unreachable**. `user_id` is cast to its own text, so an old `4f9c…` stays `4f9c…`; no Auth0 `sub` will ever be that string, so no policy will match those rows again. Nothing is deleted and nothing warns you — the affected user signs in to an empty project list, which looks exactly like a new account.

An operator with real data should build the old-uuid → Auth0-`sub` mapping *before* running it, while the old ids are still what people sign in with; the migration carries the `update` statements and the warning about an id that maps to two accounts silently merging two people's data. The database this is aimed at (`dxfxvvrbltjckstlnhup`) has been unusable since sign-in moved to Auth0 and holds nothing worth mapping — but the file outlives that fact, so it says so rather than assuming it did not matter.

### Which migrations are outstanding

Not a clean run. On the live project only `0005` has been applied; **`0003`, `0004` and `0006` all still need running**. Order between them does not matter, for the reason above.

## Verification

`npm ci`, then `npm run lint`, `npm run format:check`, `npm test` (831 passing, up from 862 across 3 deleted files — the mint's tests are replaced, not dropped), `npm run build`, plus the end-to-end smoke test CI runs (`npm run build:mock`, serve on :4173, `npm run test:e2e` — all 46 checks). Migration verified against PostgreSQL 16 as described above.

The suite still proves that an unsigned or wrong-audience token is refused, that a signed-out browser sends no token, and that the gate does not offer a sign-in the deployment cannot honour. `netlify/lib/auth.test.ts` signs real RS256 tokens with a real key pair and puts them through the real `requireSession`, so a version that decoded the claims and skipped the signature would fail it.

## For the branches already in flight

**Open branches will need to merge `main` after this lands.** The three PRs currently open are all sitting on a database they cannot read, and this is deliberately on its own branch so that it unblocks all of them at once rather than waiting behind a feature review. I kept out of the files they are also editing — `src/state/useProjectsStore.ts`, `src/state/useDriveStore.ts`, `src/lib/supabase/projects.ts`, `src/components/ProjectPicker.tsx` — except for one sentence in `projects.ts`, whose comment said the column defaults to `auth.uid()` and after `0006` no longer does.
