-- Letting somebody else onto your word shelf.
--
-- Everything this app stores has been one person's since 0001: `projects`,
-- `assets` and `word_shelves` all carry a `user_id` and one policy each saying
-- the caller's own subject must equal it. That is still the shape. What this
-- adds is a single, explicit exception, and only for the shelf — a table of who
-- has been let in, and two policies that consult it.
--
-- **Projects are deliberately not shared.** The request this answers was about
-- the tiers, languages, words and takes on the word pages, and nothing about a
-- timeline. `own_projects` is untouched below, and should stay that way unless
-- somebody asks for it: a share that quietly also handed over every project
-- would be a surprise nobody consented to.
--
--
-- HOW SOMEBODY IS NAMED
--
-- By email address, because that is the only thing the owner knows about them.
-- Auth0 subjects — `google-oauth2|104372…` — are what every policy here matches
-- on, and there is no directory in this deployment that maps one to the other:
-- Supabase has no user table (sign-in is Auth0), and asking the tenant would put
-- a Management API credential in the browser.
--
-- So a share is written with an address and no subject, and the subject is
-- filled in by the person themselves the first time they sign in — `claim` in
-- src/lib/supabase/shares.ts, allowed by the `claim_shelf_share` policy below.
-- After that one write the row is a pair of subjects like everything else, which
-- is what the R2 side needs (netlify/lib/shelfShares.ts): storage keys are
-- derived from a hash of the subject, and an address cannot get you there.
--
-- The claim requires `email_verified`, which for a Google connection is always
-- true. Without it an invitation to an address would be claimable by anyone who
-- could get a tenant to mint them a token saying they were it.
--
--
-- WHAT A SHARE ACTUALLY GRANTS
--
-- Two things, and they are not the same shape:
--
--  - **The owner's shelf row**, read and write. One direction only. Being let
--    onto somebody's shelf does not let them onto yours, so `shelf_member_of`
--    asks a directed question.
--  - **Both parties' asset rows**, read. Symmetric, and it has to be: a take
--    filed by a member is uploaded under the member's own subject — the ingest
--    path in src/lib/media.ts has one hook for the whole app and no notion of
--    whose shelf is on screen — so the owner reaching a take somebody else
--    filmed is the owner reading the *member's* row. That is what
--    `shelf_partner` answers.
--
-- The asset half is wider than the shelf it is for. `assets` rows carry no link
-- back to a shelf, so "the takes on the shared shelf" is not a question this
-- schema can ask, and the policy grants read across the whole catalogue between
-- two people who share a shelf — including images and clips made in the editor,
-- if the key or the id is known. It stops at metadata plus the ability to fetch
-- bytes; it is not a listing, because `listAssets` filters to the caller's own
-- rows (src/lib/supabase/assets.ts). Narrowing it further would mean a join
-- table of every take on every shelf, maintained on every save, and a new way
-- for the shelf and the catalogue to fall out of step. That trade is worth
-- revisiting if shares are ever handed to people the owner does not trust with
-- their whole library; today they are not.
--
-- Write stays strictly own-row for assets: `with check` below is unchanged from
-- 0006. Nobody files a row under somebody else's subject.

create table if not exists shelf_shares (
  -- Whose shelf is being shared. Defaulted from the JWT so the client never
  -- sends it, exactly as `user_id` is everywhere else here.
  owner_id     text not null default (auth.jwt() ->> 'sub'),

  -- Who it is being shared with, as the owner knows them. Stored lowercased —
  -- the check below is what makes that true rather than a convention, because
  -- the claim matches on it and `Someone@Example.com` would never be found.
  member_email text not null check (member_email = lower(member_email)),

  -- Their Auth0 subject, once they have signed in and claimed the invitation.
  -- Null until then, which is also what "invited but never turned up" looks
  -- like in the owner's sharing list.
  member_id    text,

  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,

  -- By address rather than by subject: the owner invites the same person twice
  -- by typing the same address twice, and that should be one row whether or not
  -- it has been claimed yet.
  primary key (owner_id, member_email)
);

-- The lookup both helpers below do, and the one the sharing list does.
create index if not exists shelf_shares_member on shelf_shares (member_id);

alter table shelf_shares enable row level security;

-- The owner's own rows: invite, list, revoke.
drop policy if exists own_shelf_shares on shelf_shares;
create policy own_shelf_shares on shelf_shares
  for all
  using ((auth.jwt() ->> 'sub') = owner_id)
  with check ((auth.jwt() ->> 'sub') = owner_id);

-- What a member may see: the rows they have claimed, and any invitation waiting
-- for the address they signed in with.
--
-- The unclaimed half is not only there to make the update below work. It is how
-- the page can say "so-and-so has shared a shelf with you" before anything has
-- been written, and how `claim` knows there is anything to do.
drop policy if exists read_shelf_share on shelf_shares;
create policy read_shelf_share on shelf_shares
  for select
  using (
    (auth.jwt() ->> 'sub') = member_id
    or (
      member_id is null
      and (auth.jwt() ->> 'email_verified') = 'true'
      and member_email = lower(auth.jwt() ->> 'email')
    )
  );

-- Writing your own subject onto an invitation addressed to you.
--
-- The `using` half picks the rows that may be claimed — unclaimed, and addressed
-- to this verified address. The `with check` half is what stops the update being
-- anything else: the new row must name *this* caller, and must keep the address
-- it was invited under, so a claim cannot be turned into a redirection of
-- somebody else's invitation.
drop policy if exists claim_shelf_share on shelf_shares;
create policy claim_shelf_share on shelf_shares
  for update
  using (
    member_id is null
    and (auth.jwt() ->> 'email_verified') = 'true'
    and member_email = lower(auth.jwt() ->> 'email')
  )
  with check (
    (auth.jwt() ->> 'sub') = member_id
    and member_email = lower(auth.jwt() ->> 'email')
  );

-- Leaving a shelf somebody shared with you, without needing them to do it.
drop policy if exists leave_shelf_share on shelf_shares;
create policy leave_shelf_share on shelf_shares
  for delete
  using ((auth.jwt() ->> 'sub') = member_id);

-- Whether the caller has been let onto `owner_subject`'s shelf.
--
-- `security definer` so the policies below do not have to re-enter this table
-- through its own row-level security to answer a question about a third table.
-- The caller is still read from the request's own verified claims, so definer
-- buys a straight lookup rather than any additional reach: there is no argument
-- that could make this answer about somebody else.
--
-- `search_path` pinned for the usual reason a definer function must pin it.
create or replace function public.shelf_member_of(owner_subject text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.shelf_shares
    where owner_id = owner_subject
      and member_id = (auth.jwt() ->> 'sub')
  )
$$;

-- Whether the caller and `other_subject` share a shelf, in either direction.
--
-- Undirected on purpose, and only used for `assets` — see the note at the top
-- about a member's own uploads landing under their own subject.
create or replace function public.shelf_partner(other_subject text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.shelf_shares
    where member_id is not null
      and (
        (owner_id = other_subject and member_id = (auth.jwt() ->> 'sub'))
        or (member_id = other_subject and owner_id = (auth.jwt() ->> 'sub'))
      )
  )
$$;

revoke execute on function public.shelf_member_of(text) from public;
revoke execute on function public.shelf_partner(text) from public;
grant execute on function public.shelf_member_of(text) to authenticated;
grant execute on function public.shelf_partner(text) to authenticated;

-- The shelf itself. Same policy as 0009 with one clause added.
--
-- `with check` gains the same clause because a share is read *and* write: a
-- member adding a word writes the owner's row. It is an update in practice —
-- the row exists before anybody is invited to it — but the insert case is
-- allowed too rather than left as a hole somebody trips over, and it cannot be
-- used to create a row under a subject the caller is not a member of.
drop policy if exists own_word_shelf on word_shelves;
create policy own_word_shelf on word_shelves
  for all
  using ((auth.jwt() ->> 'sub') = user_id or public.shelf_member_of(user_id))
  with check ((auth.jwt() ->> 'sub') = user_id or public.shelf_member_of(user_id));

-- Asset metadata. Read widens to whoever shares a shelf with the row's owner;
-- write does not move at all.
drop policy if exists own_assets on assets;
create policy own_assets on assets
  for all
  using ((auth.jwt() ->> 'sub') = user_id or public.shelf_partner(user_id))
  with check ((auth.jwt() ->> 'sub') = user_id);
