-- Deleting a project puts it aside for ninety days instead of destroying it.
--
-- The delete was immediate and irreversible: one click in a dropdown, one
-- `window.confirm`, and a timeline with every trim and word timing in it was
-- gone. Nothing else in this app is destructive like that — media lives in the
-- user's own Drive, where deleting it is Google's own reversible bin — so the
-- one operation that really did end things was the one with the least standing
-- behind it.
--
-- So: a `deleted_at` stamp rather than a `delete`. The row stays exactly as it
-- was, drops out of the project list, and can be put back. After ninety days it
-- is deleted for real, which is what keeps this a grace period rather than an
-- attic nobody empties.
--
-- Two functions rather than two client-side updates, because both turn on what
-- time it is, and the client's clock is not evidence. A browser an hour fast
-- makes for a cosmetically odd `updated_at`; a browser a year slow, stamping its
-- own `deleted_at`, would hand the purge below a project that looks nine months
-- expired the moment it is deleted. `now()` inside the database is the same
-- clock for everybody, and it is the one the ninety days are measured against.
--
-- Restoring needs no function: it writes a null, and a null has no clock in it.

alter table projects
  add column if not exists deleted_at timestamptz;

-- The project list is `deleted_at is null` on every load, and a partial index is
-- the shape that fits: it indexes only the rows that query can return, and the
-- archive — a handful of rows per user at most — is left to the table.
create index if not exists projects_user_live
  on projects (user_id, updated_at desc)
  where deleted_at is null;

-- Sets the clock going on a project the user has deleted.
--
-- `security invoker`, which is also the default, spelled out because it is what
-- makes this safe: the delete and the update below run as the caller, so
-- `own_projects` applies to them exactly as it does to a query from the browser.
-- A `security definer` function here would run as the owner, for whom row-level
-- security does not apply, and would happily archive anybody's project by id.
--
-- Returns the stamp it wrote, or null when the policy matched no row — which the
-- caller reports as a project that is no longer there.
create or replace function archive_project(project_id uuid)
returns timestamptz
language sql
security invoker
set search_path = public
as $$
  update projects
     set deleted_at = now()
   where id = project_id
     and deleted_at is null
  returning deleted_at;
$$;

-- The ninety days, expressed once.
--
-- The number is repeated in the client, which has to say "89 days left" on a
-- screen without asking the server — `RETENTION_DAYS` in
-- src/lib/supabase/projects.ts. This is the one that decides; that one describes
-- it. Change both or the app will promise a window it does not keep.
create or replace function purge_expired_projects()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed integer;
begin
  delete from projects
   where deleted_at is not null
     and deleted_at < now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Explicit rather than left to the `execute` that `public` gets on a new
-- function by default, so tightening that default later does not quietly stop
-- the purge from running.
grant execute on function archive_project(uuid) to authenticated;
grant execute on function purge_expired_projects() to authenticated;

-- WHAT ACTUALLY RUNS THE PURGE
--
-- The app calls `purge_expired_projects` when a session starts, which needs no
-- infrastructure and is why it is wired that way. Its limit is worth being
-- honest about: it only runs for accounts that come back. Someone who deletes a
-- project and never signs in again keeps that row indefinitely — the ninety days
-- are a promise about the earliest it can be restored until, not a guarantee
-- about the latest it can survive.
--
-- An operator who wants the second guarantee too can schedule it, on a Supabase
-- project with pg_cron enabled (Database → Extensions):
--
--   select cron.schedule('purge-expired-projects', '17 3 * * *', $cron$
--     delete from projects
--      where deleted_at is not null
--        and deleted_at < now() - interval '90 days';
--   $cron$);
--
-- Inlined rather than calling the function, because cron runs as `postgres` —
-- for whom `security invoker` means the owner, and row-level security does not
-- apply. That is exactly what a sweep across every account needs, and exactly
-- what makes it the wrong thing to expose to a browser.
