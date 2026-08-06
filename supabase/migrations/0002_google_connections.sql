-- The durable half of a Google Drive connection.
--
-- Everything else this app stores belongs to the user and is read by the user's
-- own browser under row-level security. This table is the exception: it holds
-- Google *refresh* tokens, which are long-lived credentials for someone's Drive.
-- A browser must never be able to read one — it only ever needs the hour-long
-- access token minted from it, which the Netlify function hands back per request.
--
-- So this table has row-level security on and **no policies at all**. That is
-- not an oversight: with RLS enabled and no policy, PostgREST returns nothing to
-- `anon` and nothing to `authenticated`, no matter whose token is presented. The
-- service role bypasses RLS, and the service key lives only in the function
-- environment. The grants below say the same thing a second way, so a policy
-- added here by accident later still cannot open the table up.

create table if not exists google_connections (
  -- One connection per user: reconnecting replaces the token rather than
  -- accumulating rows, and there is nothing to choose between at read time.
  user_id       uuid primary key references auth.users (id) on delete cascade,

  -- Google's long-lived credential. Exchanged for an access token on demand and
  -- never sent to the browser.
  refresh_token text not null,

  -- What the user actually granted. Recorded because Google may issue fewer
  -- scopes than were asked for, and because the app's scope list can change in a
  -- later release — either case means "ask again" rather than a confusing 403
  -- from Drive later.
  scope         text not null default '',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table google_connections enable row level security;

revoke all on google_connections from anon, authenticated;
