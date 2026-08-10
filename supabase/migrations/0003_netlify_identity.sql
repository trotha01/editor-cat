-- Netlify Identity as the account, instead of Supabase Auth.
--
-- Sign-in now goes through Netlify Identity (Google SSO), and `/api/session`
-- turns the Identity token into a Supabase session signed with this project's
-- own JWT secret. Everything Postgres relies on still works exactly as before:
-- the token carries `role: authenticated` and a `sub` claim, so `auth.uid()`
-- returns the signed-in user and the `auth.uid() = user_id` policies on
-- `projects` and `assets` need no change at all. Netlify Identity issues UUIDs
-- for user ids, so the column types do not change either.
--
-- What does have to go is the foreign key. `user_id` pointed at `auth.users`,
-- and a Netlify account has no row there — so every insert would fail on a
-- constraint referencing a table this app no longer populates.
--
-- Two consequences worth knowing about:
--
--  * Deleting a user no longer cascades, because there is no longer a row whose
--    deletion could cascade. Removing someone's data is a Netlify Identity
--    delete plus a `delete from projects where user_id = ...` (and the same for
--    `assets` and `google_connections`).
--  * `user_id` is no longer checked against a list of known accounts. Nothing
--    rested on that: the value comes from a signed token either way, and RLS —
--    not the foreign key — is what stops one user reaching another's rows.
--
-- Existing rows keep working only if the same person's Netlify Identity id
-- happens to match their old Supabase Auth id, which it will not. A deployment
-- with real data in it should map the old ids across before running this;
-- a fresh one has nothing to move.

alter table projects
  drop constraint if exists projects_user_id_fkey;

alter table assets
  drop constraint if exists assets_user_id_fkey;

alter table google_connections
  drop constraint if exists google_connections_user_id_fkey;
