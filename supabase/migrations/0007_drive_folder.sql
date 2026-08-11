-- Where a user's media goes, kept against the account rather than the browser.
--
-- The chosen Drive folder used to live in localStorage and nowhere else, which
-- made it a fact about a browser instead of a fact about a person. Signing out
-- clears that copy on purpose — it is an id in one account's Drive, and leaving
-- it behind would upload the next person's media somewhere they cannot reach —
-- so every sign-in arrived with nothing chosen, and the gate asked "Where should
-- your media go?" again. A second machine, or cleared site data, did the same.
-- The answer was already given; there was simply nowhere durable to give it to.
--
-- One row per user, holding the folder's id and the name to show for it.
--
-- Not a credential, unlike the table 0002 added and 0004 dropped. A Drive folder
-- id is inert on its own: reaching the folder still needs a Google token for an
-- account the folder is shared with, which is Auth0's to issue and nothing here
-- can produce. It is stored under the same row-level security as everything else
-- all the same, because it is nobody's business but its owner's.
--
-- `user_id` is `text` and the policy reads `auth.jwt() ->> 'sub'`, for the same
-- reason the other tables do since 0006 — Auth0 subjects (`google-oauth2|104372…`)
-- are not UUIDs, and `auth.uid()` casts to one. That is a convention shared with
-- 0006 rather than a dependency on it: this file creates its own table and
-- alters nothing, so it applies in any order relative to the rest.

create table if not exists drive_folders (
  -- One folder per account: choosing again replaces the row rather than
  -- accumulating, so there is nothing to choose between at read time.
  --
  -- Defaulted from the JWT so the client never sends it, and row-level
  -- security's with-check has nothing to disagree with.
  user_id     text primary key default (auth.jwt() ->> 'sub'),

  folder_id   text not null,

  -- Stored rather than looked up. Settings prints this on every load, and
  -- asking Drive for it would mean a request before the screen can draw — for a
  -- string that only changes when the user renames the folder themselves.
  folder_name text not null,

  updated_at  timestamptz not null default now()
);

alter table drive_folders enable row level security;

-- The same shape as `own_projects` and `own_assets`: one policy, every command,
-- the caller's own subject against the row's.
drop policy if exists own_drive_folder on drive_folders;
create policy own_drive_folder on drive_folders
  for all
  using ((auth.jwt() ->> 'sub') = user_id)
  with check ((auth.jwt() ->> 'sub') = user_id);
