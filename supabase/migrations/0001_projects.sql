-- Projects and asset metadata.
--
-- Media bytes are not here. They live in the user's own Google Drive, and in
-- IndexedDB on whichever machine is editing; what this schema stores is the
-- timeline itself plus enough metadata to reconnect a timeline to those Drive
-- files on a machine that has never seen them.

create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  -- Defaulted from the JWT so the client never sends it, and RLS's with-check
  -- has nothing to disagree with.
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null default 'Untitled project',

  -- The whole editor document: clips, audioTracks, audioClips, captionTracks,
  -- captionCues, width, height, fps. Kept as one value rather than relational
  -- rows because the clip list is order-significant (a clip's start time is the
  -- sum of the durations before it), so rows would need a position column
  -- renumbered on every drag — and because captions are words with their own
  -- timings, which as rows would be a table with one entry per spoken word,
  -- rewritten wholesale every time a line is retyped.
  doc            jsonb not null,

  -- Recorded rather than sniffed, so migrateProject upgrades old documents off
  -- a known version. 1 was the flat voiceovers list, 2 multitrack audio, 3
  -- captions. Only a default: the client writes this on every insert and update,
  -- so an existing database needs no change when the shape moves on.
  schema_version integer not null default 3,

  -- Optimistic concurrency. Writers update where version matches and bump it;
  -- zero rows affected means another tab or device moved ahead.
  version        integer not null default 1,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists projects_user_updated
  on projects (user_id, updated_at desc);

create table if not exists assets (
  -- The app's own asset id, so ids inside a project document never need
  -- remapping. Unique per user rather than globally.
  id            text not null,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,

  kind          text not null check (kind in ('image', 'video', 'audio')),
  name          text not null,
  mime_type     text not null,
  width         integer,
  height        integer,
  duration      real,
  prompt        text,

  -- The provider URL this came from. Kept for provenance only: fal URLs expire,
  -- so it is not a reliable way to fetch the bytes back.
  source_url    text,

  -- The durable pointer. Null until the Drive upload finishes, or forever if
  -- the user never connected Drive.
  drive_file_id text,
  byte_size     bigint,

  created_at    timestamptz not null default now(),

  primary key (user_id, id)
);

alter table projects enable row level security;
alter table assets   enable row level security;

drop policy if exists own_projects on projects;
create policy own_projects on projects
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists own_assets on assets;
create policy own_assets on assets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
