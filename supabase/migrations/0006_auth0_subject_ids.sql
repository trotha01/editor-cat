-- Auth0 subjects are not UUIDs.
--
-- Supabase now trusts Auth0 directly, as a third-party auth provider registered
-- on the project: PostgREST validates the tenant's own token against the
-- tenant's own published keys, and nothing signs a Supabase-shaped session any
-- more. That change is invisible to Postgres except in one place, and it is the
-- one place that matters.
--
-- `auth.uid()` is `(current_setting('request.jwt.claims')::jsonb ->> 'sub')::uuid`.
-- It has worked here so far because every identity system this app has used
-- issued UUIDs: Supabase Auth did, and so did Netlify Identity, so 0003 could
-- move the account system across and leave the column types alone. Auth0 does
-- not. Its subjects name the connection that produced them —
-- `google-oauth2|104372…`, `auth0|42` — and that cast fails outright. Not "no
-- rows": every single query against these tables raises
--
--   22P02  invalid input syntax for type uuid: "google-oauth2|104372…"
--
-- So the columns become `text` and the policies stop asking for a UUID. What
-- replaces `auth.uid()` is `auth.jwt() ->> 'sub'` — the same claim out of the
-- same verified token, read as the string it actually is.
--
--
-- WHY 0006 AND NOT 0005
--
-- 0005 is deliberately skipped. `0005_project_drive_folder.sql` belongs to an
-- open pull request that adds a `drive_folder_id` column, and it has already
-- been applied to the live project. Numbering around it means neither branch has
-- to be renumbered whichever merges first. The two are independent — one adds a
-- column, the other changes a type and rewrites policies — so they may be
-- applied in either order. There is no missing file.
--
--
-- WHAT HAPPENS TO ROWS THAT ALREADY EXIST
--
-- They survive the migration and become unreachable. `user_id` is cast to its
-- own text, so `4f9c…-…` stays `4f9c…-…`; no Auth0 `sub` will ever be that
-- string, so no policy will ever match those rows again. Nothing is deleted, and
-- nothing warns you — the affected user simply signs in to an empty project
-- list, which looks exactly like a new account.
--
-- An operator with real data should build the mapping *before* running this,
-- while the old ids are still the ones people are signing in with: for each
-- account, record the old `user_id` alongside the Auth0 `sub` the same person
-- now arrives with (the tenant's user list, matched on email address, is the
-- usual source). Then, after this migration, apply it:
--
--   update projects set user_id = 'google-oauth2|1043…' where user_id = '4f9c…';
--   update assets   set user_id = 'google-oauth2|1043…' where user_id = '4f9c…';
--
-- Run those as the owner or with RLS bypassed; the policies below will not match
-- the rows being fixed. Do it in one transaction per account, and check the
-- counts — an id that maps to two accounts silently merges two people's data.
--
-- The project this was written against, `dxfxvvrbltjckstlnhup`, has been
-- unusable since sign-in moved to Auth0 and holds nothing worth mapping. That is
-- a fact about one database on one day, and this file will outlive it, which is
-- why the paragraph above is here rather than a note that it did not matter.

-- The foreign keys 0003 dropped, dropped again.
--
-- Not belt and braces, and not a no-op on a project where 0003 has already run:
-- this is what makes the file safe to apply to one where it has not. 0001
-- declared `user_id ... references auth.users (id)`, and `alter column ... type`
-- rebuilds every constraint that depends on the column — so a surviving foreign
-- key would be rebuilt as text-referencing-uuid, which has no equality operator:
--
--   ERROR:  foreign key constraint "projects_user_id_fkey" cannot be implemented
--   DETAIL: Key columns "user_id" and "id" are of incompatible types: text and uuid.
--
-- That made this file quietly dependent on 0003 having run first, which on the
-- project it was written for is not true — 0003 is still outstanding there. Two
-- idempotent statements are cheaper than an ordering constraint nobody can see
-- from inside either file. Everything 0003 says about the consequences of losing
-- these constraints still applies and is not repeated here.
alter table projects drop constraint if exists projects_user_id_fkey;
alter table assets   drop constraint if exists assets_user_id_fkey;

-- The policies have to go next. Postgres refuses to alter the type of a column
-- named in a policy expression — "cannot alter type of a column used in a policy
-- definition" — and both of these compare against `user_id`. They are recreated
-- at the bottom of this file, against the same column, reading the same claim.
drop policy if exists own_projects on projects;
drop policy if exists own_assets   on assets;

-- And the defaults, which have to go because they are being replaced rather than
-- because the type change could not cope: `auth.uid()` returns uuid, and a
-- default that keeps casting a claim to uuid is the exact failure this migration
-- exists to remove. Set again below, reading the claim as text.
alter table projects alter column user_id drop default;
alter table assets   alter column user_id drop default;

-- The type change itself.
--
-- `using user_id::text` is the identity conversion — a uuid rendered in the
-- canonical hyphenated form it already prints as — so the stored values do not
-- move. Postgres would in fact reach the same conversion on its own, through the
-- I/O cast every type has to text; it is spelled out because a `USING` clause is
-- the difference between a conversion someone chose and one that happened, and
-- this statement rewrites the primary key of every row in both tables.
--
-- Both indexes on these columns are rebuilt by Postgres as part of the same
-- statement, so `projects_user_updated` (user_id, updated_at desc) keeps
-- working, and so does the `assets` primary key (user_id, id). Neither needs to
-- be dropped, recreated, or reindexed here. Text compares under the database's
-- default collation rather than uuid's byte order, which changes the order rows
-- come back in for a scan that spans users; nothing does that, because every
-- query is filtered to one user by the policies below.
alter table projects
  alter column user_id type text using user_id::text;

alter table assets
  alter column user_id type text using user_id::text;

-- Defaulted from the JWT so the client never sends it, and RLS's with-check has
-- nothing to disagree with — exactly what `default auth.uid()` was doing in
-- 0001, now reading the claim without the cast that fails.
--
-- `auth.jwt()` rather than `current_setting('request.jwt.claims')` directly: it
-- is Supabase's own accessor for the verified claims of the current request, it
-- reads the setting with `missing_ok` so an unauthenticated request gets NULL
-- rather than an error, and it is what their third-party auth documentation
-- uses. NULL is the right answer for a request with no token — `NULL ->> 'sub'`
-- is NULL, which fails the policies below and violates the `not null` on the
-- column, so both directions fail closed.
alter table projects
  alter column user_id set default (auth.jwt() ->> 'sub');

alter table assets
  alter column user_id set default (auth.jwt() ->> 'sub');

-- Row-level security stays exactly what it was: one policy per table, covering
-- every command, matching the caller's own subject against the row's. Only the
-- spelling of "the caller" has changed.
--
-- One claim these policies do not mention still has to be right, and it is not
-- set here: `role`. PostgREST switches to the Postgres role the JWT names, and
-- `authenticated` is the role these tables are meant to be read as. Auth0 does
-- not put it there by itself — a Login Action does, and Supabase's own Auth0
-- guide requires one. A token arriving without it is read as `anon`, which in a
-- stock Supabase project still holds table grants on the public schema, so the
-- failure is not guaranteed to be loud: it may work by accident today and stop
-- the moment those grants are tightened. Set the claim. See the README.
create policy own_projects on projects
  for all
  using ((auth.jwt() ->> 'sub') = user_id)
  with check ((auth.jwt() ->> 'sub') = user_id);

create policy own_assets on assets
  for all
  using ((auth.jwt() ->> 'sub') = user_id)
  with check ((auth.jwt() ->> 'sub') = user_id);
