-- The word shelf: the tiers, the languages under them, the words under those,
-- and the order, labels and transcripts of each word's takes.
--
-- This used to live in the user's Drive, as one `editor-cat.json` beside the
-- videos in every word folder. That was the price of keeping the shelf as
-- folders: a folder holds files but cannot hold an order, a role or a line of
-- transcript. It worked, and it cost a file in every folder somebody opens on
-- their phone, plus a listing and a download per word on every read — sixty-odd
-- round trips to Drive before a shelf of twenty-three words could be drawn.
--
-- The folders stay. They are where the videos live and what makes the shelf
-- legible in Drive without this app. What moves here is only the part a folder
-- was never able to hold, and the structure that goes with it, so a machine can
-- have the whole shelf in one query and draw it without Drive answering at all.
--
-- One row per user, holding the shelf as a document, for the same reason
-- `projects.doc` is a document: a word's run of takes is order-significant, so
-- rows would need a position column renumbered on every drag. A shelf is small —
-- names, ids, an order and a line of transcript each — and it is always read and
-- written whole.
--
-- `user_id` is `text` and the policy reads `auth.jwt() ->> 'sub'`, the
-- convention every table here has followed since 0006: Auth0 subjects
-- (`google-oauth2|104372…`) are not UUIDs, and `auth.uid()` casts to one.

create table if not exists word_shelves (
  -- One shelf per account, so there is nothing to choose between at read time.
  -- Defaulted from the JWT so the client never sends it, and row-level
  -- security's with-check has nothing to disagree with.
  user_id        text primary key default (auth.jwt() ->> 'sub'),

  -- The whole shelf: tiers, languages, words, and each word's videos in the
  -- order they play, with the Drive folder ids that tie them to the files.
  doc            jsonb not null,

  -- Recorded rather than sniffed, so a later shape can be read off a known
  -- version. Only a default: the client writes it on every save.
  schema_version integer not null default 1,

  -- Optimistic concurrency, as on `projects`. A writer updates where the
  -- version still matches and bumps it; zero rows affected means another tab or
  -- another machine moved ahead, and the writer re-reads before trying again.
  version        integer not null default 1,

  updated_at     timestamptz not null default now()
);

alter table word_shelves enable row level security;

-- The same shape as `own_projects`, `own_assets` and `own_drive_folder`: one
-- policy, every command, the caller's own subject against the row's.
drop policy if exists own_word_shelf on word_shelves;
create policy own_word_shelf on word_shelves
  for all
  using ((auth.jwt() ->> 'sub') = user_id)
  with check ((auth.jwt() ->> 'sub') = user_id);
