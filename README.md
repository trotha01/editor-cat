# editor-cat

A small AI video editor that runs in your browser.

Write a prompt → get images → animate one into a clip → arrange clips on a
timeline → dissolve between them → layer voiceovers and music → swap your voice
for another one → caption it karaoke-style → export an MP4.

Images, video and caption transcription all run on the deployment's own fal.ai
account, so visitors need **no key** for any of them. Voice conversion uses
**your own ElevenLabs key**, held in your browser.

---

## What it does

| Step             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Image**    | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **2 · Video**    | Pick a generated image as the opening frame and animate it with Seedance 2.0 at 480p. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Timeline**     | Drag clips to reorder, drag their edges to trim, set how long stills stay on screen. Every clip carries a **⋯ menu** with what can be done to that clip alone — caption it, silence it, take it off the timeline. **Cut** (or `S`) splits the clip under the playhead in two; zoom in and every frame gets its own line to aim at. The mark between two clips opens a **transitions** picker — cross dissolve, dips, wipes, slides, blur and an iris — with a duration you can drag and an **Apply to all**. Clips that came with sound keep it, at a level you set per clip. Give the picture a **lead-in** to slide the whole track later and open black in front of it. A **clip sound** lane under the picture draws the waveform of whatever audio each video clip carries. Audio sits on its own stacked tracks below. |
| **Preview**      | Play the timeline back with the transport, or press **Fullscreen** (or `F`) to watch it filling the screen with the controls still to hand. `Space` plays and pauses, arrows nudge the playhead, `Esc` comes back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **3 · Audio**    | Record as many voiceover takes as you like — they layer onto separate tracks automatically. Add music that sits under them. Drop in a **three-beep count-in** and drag it to the exact moment it should lead into. Convert any take into another voice with ElevenLabs; the original is always kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **4 · Captions** | **Add captions** transcribes the speech on the timeline with ElevenLabs Scribe, and lays it out karaoke-style: one caption on screen at a time, with the word being spoken picked out. The transcript is editable — retype a misheard word and every other timing in the line is left alone. Any single clip can be captioned or redone from its own **⋯ menu on the timeline**, which replaces only that clip's captions and leaves every correction made elsewhere standing. Captions get a lane of their own, where they can be retimed, trimmed, split and joined, and each word has a mark you can drag until the highlight lands on the voice. Large and bold by default; size, colour, weight and height are adjustable.                                                                                              |
| **Export**       | Render an MP4 in the browser with ffmpeg compiled to WebAssembly, captions burnt in. Nothing is uploaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## What you need

**As a visitor:** nothing. Image and video generation and caption transcription
all run on the site's own fal.ai account. A key buys you voice conversion.

- **[ElevenLabs](https://elevenlabs.io)** — entered in **Settings**. Needed for changing your recorded voice, and for nothing else. It is held in your browser: tick _remember on this device_ and it goes into local storage, leave it off and it is gone when you close the tab. Either way it is attached to each request as it passes through this site's proxy, and is never written to a server or a log.

**As whoever deploys it:** a [fal.ai](https://fal.ai/dashboard/keys) key set as
`FAL_KEY` in the site environment. See [Deploying to Netlify](#deploying-to-netlify).

**Costs are real, and they land on the deployment.** Images are roughly
$0.003–$0.04 each; video is roughly $0.04 per second at 480p on the default
model, rising to $0.40 on the most expensive one in the picker. Captions are
$0.008 per minute of audio transcribed. The app shows an estimate before every
button that spends money, because a mis-click on a video model is expensive —
and because pressing **Add captions** again transcribes the whole timeline
afresh. When one clip is the problem, redo that clip from its **⋯ menu on the
timeline**: the price is on the menu item, and that clip is the only thing
transcribed.

## Shape

Projects are **vertical 9:16 by default**. The Orientation toggle above the
preview switches the whole pipeline at once — the shape of generated images, the
aspect ratio sent to the video model, and the export frame — because a clip
generated one way up and exported the other just gets black bars. Existing
projects keep the orientation they were made with until you change it.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:5173 — UI only, /api/* is unavailable
```

To exercise the real providers you need the Netlify functions running too, with
a `.env` holding at least `FAL_KEY` (copy `.env.example` and see the notes
there):

```bash
npm install -g netlify-cli
netlify dev          # serves the app and /api/* together
```

Against a checkout with no Supabase project, add `FAL_PROXY_ALLOW_ANONYMOUS=1`
so the fal proxy stops asking for a session it cannot verify.

Signing in needs Auth0, which works anywhere the app is served from — including
`npm run dev`, so long as `http://localhost:5173` is in the application's allowed
callback and origin lists.
`netlify dev` proxies it for you once the checkout is linked to one; plain `npm
run dev` does not, so point it at a deployed site with
`VITE_NETLIFY_IDENTITY_URL=https://your-site.netlify.app/.netlify/identity` — or
skip sign-in altogether with mock mode below.

### Trying it without any keys

```bash
VITE_MOCK_PROVIDERS=1 npm run dev
```

Mock mode fakes every provider call locally and needs no keys and no network.
The media it produces is real — images are drawn on a canvas and videos are
recorded off an animated one — so the timeline, preview and export all get a
genuine workout. This is also what the end-to-end test drives.

## Saving projects (optional)

With a Supabase project configured, the app asks you to sign in with Google —
through **Auth0** — and then keeps your timelines in your account: a
project switcher in the header, auto-save about two seconds after you stop
editing, and projects that open on any machine you sign in from.

**Getting in is three steps, and each asks for one thing.** Sign in with Google;
grant permission to write to your Drive; pick the folder your media goes into.
Then the editor. The second step is asked with the first one's email as a hint,
so Google does not make you choose an account twice. Settings keeps the folder
and the sign-out, and nothing else about Google.

It used to be two steps, because one Google consent screen covered both identity
and Drive. Auth0 carries the Drive scope through its login, so it is one screen
again — what
it returns proves who you are and nothing more — so the grant that used to ride
along now has a screen of its own. See [what sign-in
needs](#what-sign-in-needs).

**What lives where.** Supabase holds the timeline — clips, tracks, trims, audio
placement, resolution, and the captions with every word timing in them — plus a
catalogue of asset metadata. It never holds media bytes. Those are in your Google Drive, and cached in each browser's IndexedDB.
Opening a project on a new machine restores the timeline from metadata
immediately, so you can rearrange it while the media is still coming down from
Drive behind you.

**Media that predates Drive cannot be recovered on another machine.** An asset
with no `driveFileId` only ever existed in the browser that made it; those clips
open with their timing intact and report as unrecoverable.

Leave `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` unset and the app behaves
exactly as it did before: one project, IndexedDB, no sign-in.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com).
2. Run the files in `supabase/migrations/` in order — paste them into the
   dashboard's **SQL editor**, or `supabase db push` with the CLI. `0001` creates
   the projects and assets tables with row-level security, so a user can only
   ever read and write rows on their own account. `0002` adds the table that
   holds Google refresh tokens, which no browser can read at all — Drive does
   not work without it, so it is not optional. `0003` drops the foreign keys
   that pointed at `auth.users`, which an external account has no row in;
   without it every insert fails on a constraint.
3. **Supabase Auth is not used at all** — there is no provider to enable there.
   What Supabase needs instead is its signing secret, under **Project settings →
   API → JWT keys**, set as `SUPABASE_JWT_SECRET` in the site environment. See
   [what sign-in needs](#what-sign-in-needs).
4. Copy the project URL and anon key from **Project settings → API** into `.env`
   (and into Netlify's environment variables), then redeploy.

Row-level security is still what protects the data, and the policies are
untouched: `/api/session` signs a Supabase-shaped session carrying the Netlify
Identity user id, so `auth.uid()` resolves exactly as it did before. This is the
same shape as Supabase's own third-party auth integrations — the external
provider stays the identity, and Postgres stays the thing that guards the rows.

### Which build is deployed

Type **`VERSION`** in the browser console on any deployed site:

```js
VERSION
// { commit: "91d8e38…", short: "91d8e38", branch: "staging",
//   context: "branch-deploy", builtAt: "2026-08-06T22:24:11.368Z" }
```

Stamped in at build time from Netlify's own `COMMIT_REF`, `BRANCH` and
`CONTEXT`, falling back to git for a local `npm run build`. It is set before
anything else runs, so it answers even on a screen that is refusing to let you
in — which is usually when you need it. The `branch` is the field that matters
most: a branch deploy running code older than the branch you fixed it on looks
identical to a bug from the outside.

### Which PR staging is showing

On the staging site — and only there — a line sits in the bottom-left corner:

```
PR #412 · feat/oauth-refresh · a1b3c9d · 3m ago
```

`staging` is main plus every open PR, rebuilt from scratch whenever any of them
moves, and all of it deploys to one fixed address because that address is
registered with Google and a per-PR URL could not sign anyone in. So the site
cannot introduce itself: `VERSION` there says `staging` and a merge commit
written by a bot, which is true and useless. The badge names the pull request
whose push caused the rebuild — not the only one in the build, since every open
PR is in there, but the one that answers "is what I am looking at mine?".

- **The commit** is the PR branch's own tip, so it compares directly against a
  local `git rev-parse --short HEAD`.
- **The age updates as you watch**, and past half an hour turns amber with a
  `⚠`: rebuild plus deploy takes a few minutes, so anything older has been
  superseded, or the mirror hit a conflict, or the deploy failed. Whichever it
  is, it is not your build.
- **Clicking it** opens the PR title, the author and the full build time.
  **`PR #412`** opens the pull request in a new tab, and **`✕`** hides the badge
  until the tab is closed.
- It takes no clicks that were not aimed at it, so the editor underneath stays
  usable right up to its edge.

**Why it cannot appear anywhere else.** The workflow writes `staging-build.json`
into the branch just before pushing it (`.github/workflows/staging.yml`), and
Vite inlines it at build time next to `__BUILD__`. No other branch carries that
file, so every other build inlines `null` and has nothing to draw. On top of
that the badge compares `location.hostname` against the address Netlify gave the
build, and stays away unless they match — so the same bundle served from a local
`vite preview`, or promoted somewhere it should not have been, shows nothing.
Production is excluded twice, and neither time by remembering to exclude it.

That host comes from Netlify's `DEPLOY_PRIME_URL` (or `URL`), which needs no
setup. Set **`STAGING_HOST`** in the site's environment variables only if
staging is reached through a domain Netlify does not name — a bare host or a
full URL, either will do. Get it wrong and the badge simply never appears;
nothing else changes.

### Conflicts

Each project row carries a version. A write only lands if the version still
matches what this session last saw, so editing the same project in two tabs
shows "Changed elsewhere" rather than one tab silently overwriting the other.
Resolution is a reload — merging two timelines has no sensible automatic answer.

## Saving to your own Google Drive (optional)

Drive is asked for in the step straight after signing in, and the one after
_that_ is choosing where your media goes: make an `editor-cat` folder in one
click, or pick an existing one. From then on everything the app makes —
generated images, rendered clips, recordings, files you upload — is copied into
that folder as it is created, and **Library → Import from Drive** opens the
Google Picker inside it to bring existing media in.

The editor does not open until all three are in place — session, permission,
folder — because an editor that silently saves nowhere is worse than one more
click. Declining the Drive permission on Google's own consent screen therefore
sends you back to the same button, with a way to switch accounts.

The connection belongs to the account, not the browser, so this is a one-time
step: signing in on another machine resumes it without asking again. It only
comes back if the grant is revoked or expires, and then the screen says which.

**Signing out** is in Settings, under Account. It leaves your projects and your
media where they are and clears this browser: the Google permission held in
memory, and the folder new media was being saved into.

The bytes stay in IndexedDB either way; Drive is the durable copy, not the
playback source. Drive has no URL that carries our token _and_ serves range
requests, so a `<video>` pointed straight at it could not seek — and export
needs the bytes locally regardless. A failed upload therefore costs you the
backup and nothing else.

The Auth0 settings are what turn Drive on, because Drive rides on the same
login. There is no Google client id in this repository any more: Auth0 holds it,
and your Google console only ever learns about Auth0.

### Setting up Auth0

Sign-in and Drive are one consent, so this is one setup rather than two. Auth0
holds the Google client; your Google Cloud console only ever learns about Auth0.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API** and the **Google Picker API**.
2. Configure the **OAuth consent screen**. While it is in _Testing_ you can add
   up to 100 test users and nothing further is required.
3. Create an **OAuth client ID** of type _Web application_. Its one authorised
   redirect URI is Auth0's: `https://YOUR_TENANT.us.auth0.com/login/callback`.
   Not this site's — no URL of yours goes in this list, now or ever, which is
   what makes deploy previews possible at all.
4. In Auth0, create a **Google social connection** with that client id and
   secret. Under its settings:
   - add `https://www.googleapis.com/auth/drive.file` to the connection scopes,
   - enable **Offline Access** in Permissions, so Auth0 can hold a refresh token,
   - turn on **Connected Accounts for Token Vault**, which is what lets the
     functions exchange a caller's token for a Google one.
5. Create an **API** in Auth0 — its identifier is `VITE_AUTH0_AUDIENCE`, and any
   URI will do so long as it matches everywhere.
6. Create a **Single Page Application** for the browser. Its client id is
   `VITE_AUTH0_CLIENT_ID`; its Allowed Callback URLs, Allowed Logout URLs and
   Allowed Web Origins cover wherever the app is served from.
7. On that API's page, press **Add Application**, name it, and press **Add** —
   which, despite the wording, creates a **Custom API Client** rather than
   authorising an application that already exists. Then **Configure
   Application**: its type reads _Custom API Client_, and under Advanced
   Settings → Grant Types the **Token Vault** grant is already enabled. Its
   client id and secret are `AUTH0_BACKEND_CLIENT_ID` and
   `AUTH0_BACKEND_CLIENT_SECRET`.

   Not a machine-to-machine application, however generously granted. Access
   token exchange is the variant where the caller _is_ the resource server the
   token was minted for, and Auth0 decides that by whose credentials signed the
   request — a Custom API Client shares the API's identifier, which is the whole
   of what makes it the same entity. An M2M client answers "This client is not a
   resource server and cannot exchange access tokens."

8. Create a Google **API key** under the same Cloud credentials page, restricted
   by HTTP referrer. The Picker will not open without one.

```
VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=            # the SPA application
VITE_AUTH0_AUDIENCE=https://editor-cat/api
VITE_GOOGLE_API_KEY=AIza...
VITE_GOOGLE_PROJECT_NUMBER=1234567890   # Cloud console → project number

AUTH0_BACKEND_CLIENT_ID=         # the API's Custom API Client, not an M2M app
AUTH0_BACKEND_CLIENT_SECRET=     # scoped to Functions, and genuinely secret
```

Only the last one is a secret. The rest ship in the bundle by design, and
referrer allowlisting is what protects the API key. The project number is passed
to the Picker as its app id, which is what Google requires for files picked
there to stay reachable under `drive.file`.

Optionally, add an Auth0 **Action** that puts the address into the access token
as `https://editor-cat/email`. Nothing depends on it — the browser reads the
address from its own ID token — but without it the minted Supabase session
carries an empty `email` claim.

### Deploy previews

They work, and they need nothing per preview.

Google matches redirect URIs byte for byte and accepts no wildcard, which is why
this used to be impossible: Netlify gives every pull request a host of its own,
and there is no registering those in advance. Since Google now only ever sees
Auth0's callback, that constraint lands on Auth0 instead — and Auth0 takes a
wildcard subdomain.

Add `https://*.staging.your.site` to the SPA application's **Allowed Callback
URLs**, **Allowed Logout URLs** and **Allowed Web Origins**, and give previews
hosts under that domain with Netlify's **Automatic deploy subdomains**.

> **Only a domain you own.** Never `https://*.netlify.app`: every site Netlify
> hosts matches it, so anyone could deploy one and be handed your users' tokens.
> The same goes for the API key's referrer list, which needs
> `https://*.staging.your.site/*` for the Picker — that one is a separate Google
> allowlist, because the Picker calls Google straight from the page and Auth0 is
> nowhere in that path.

Deploys stay reachable at `*--sitename.netlify.app` too, and those hosts are
outside the wildcard, so sign-in will refuse them. That is the allowlist working;
use the subdomain URLs.

### What sign-in needs

Beyond the Auth0 setup above, one secret and one project URL, both **scoped to
Functions** — they are read at request time, not at build time. Marking a
`VITE_` variable secret makes secrets scanning fail the build, so mark only
these.

```
SUPABASE_JWT_SECRET=             # Supabase → Project settings → API → JWT keys
AUTH0_BACKEND_CLIENT_SECRET=     # the API's Custom API Client
```

Run the migrations in `supabase/migrations/` in order. `0004_auth0.sql` drops the
`google_connections` table, which nothing writes to any more.

**Why a signing secret.** Auth0 says who someone is. Supabase will not take its
word for it: row-level security reads `auth.uid()` out of a JWT signed with the
project's own key, and an Auth0 token presented to PostgREST is simply rejected.
So `/api/session` verifies the Auth0 token and signs a Supabase-shaped one
carrying the same user id. RLS stays the security boundary, and every query in
`src/lib/supabase/*` is untouched — the same shape as Supabase's own third-party
auth integrations.

**No round trip to verify.** Auth0 signs with RS256 and publishes the public
half, so `netlify/lib/auth0.ts` checks a token without leaving the process —
signature, issuer, audience and expiry, with the signing keys cached and
refetched once on an unrecognised key id. Netlify Identity could not be verified
locally at all, so this is one hop cheaper than what it replaced.

**Where the Drive token comes from.** Auth0's Token Vault holds the Google
tokens. `/api/google/token` exchanges the caller's Auth0 token for a Google one
(`netlify/lib/tokenVault.ts`), so Google's refresh token never reaches this
codebase — there is none here to leak, and no table to back up or lose. That
endpoint is the one place that takes the Auth0 token rather than the minted
Supabase session, because the Auth0 token is the subject of the exchange.

### One scope, and why

`drive.file` is the only Drive scope this app asks for: per-file access to what
it creates, plus whatever you hand it through the Google Picker. It cannot see
anything else in your Drive, and the consent screen says as much.

That is possible because **the Picker does the browsing**. It runs against your
own Google session rather than this app's token, so it shows your real Drive;
whatever you select is then granted to the app, file by file. Listing your folder
ourselves would need `drive.readonly` — a Google _restricted_ scope, rendered as
"See and download all your Google Drive files", and requiring their annual
third-party security assessment before the consent screen can be published.
Using the Picker instead is Google's own recommendation, and it is what lets this
app go public without that assessment.

The practical limit: `drive.file` does **not** grant access to files already
inside a folder you pick — only to the folder itself, and to files the app
created or you selected. So import always goes through the Picker, and there is
no way to enumerate a folder behind your back.

## Deploying to Netlify

The repo is deploy-ready; `netlify.toml` already declares the build command,
publish directory, functions directory, SPA fallback and security headers.

1. In Netlify, **Add new site → Import an existing project**.
2. Pick this repository. The build settings are detected from `netlify.toml`.
3. Deploy.
4. If anyone is to sign in, turn on **Identity** for the site and enable
   **Google** under its external providers.

If you are using the Drive integration, set the `VITE_AUTH0_*` variables in the
site's environment variables and add the deployed origin to the Auth0
application's allowed callback, logout and web-origin lists.

### The one secret this needs

Set **`FAL_KEY`** in the site's environment variables, for **all deploy
contexts** — scoped to production only, every deploy preview answers 503. No
`VITE_` prefix: that would inline it into the browser bundle and publish it.

Then decide who is allowed to spend it. `/api/fal/*` generates video on your
account, so it verifies the caller's session before attaching the key:

- **`SUPABASE_JWT_SECRET`** is what it verifies against — the same secret
  `/api/session` signs with, so a session it minted is the only thing the proxy
  accepts. Verification is local, with no round trip per request, which matters
  because a single video job polls for minutes.
- **Without it the proxy refuses every request** rather than running open.
  `FAL_PROXY_ALLOW_ANONYMOUS=1` overrides that for local `netlify dev`; setting
  it on a deployed site hands your fal credits to anyone who finds the URL.
  Netlify's own password protection or access controls are worth adding on top
  if the site is not meant to be public at all.

The `VITE_AUTH0_*` and `VITE_SUPABASE_*` variables are build-time
and not secret — the anon key is protected by row-level security, and the client
ID by origin allowlisting.

Three are **required if you want anyone to be able to sign in and save**:
**`SUPABASE_JWT_SECRET`** and **`AUTH0_BACKEND_CLIENT_SECRET`**. See [what
sign-in needs](#what-sign-in-needs).

## How it fits together

```
Browser (React + TypeScript + Tailwind)          Netlify Functions (stateless pass-through)
  Settings  — one key, in memory or local          /api/session      → .netlify/identity
  Generate  — images, then image → video             verifies the Identity token once,
  Library   — blobs in IndexedDB                     signs the hour-long Supabase session
  Timeline  — picture + audio + caption lanes      /api/fal/*        → queue.fal.run
  Captions  — words with their own timings           session verified, site's key attached
  Speech    — audio decoded here, Scribe there     /api/elevenlabs/* → api.elevenlabs.io
  Sign-in   — Auth0 (auth0-spa-js)                   the caller's own key, forwarded once
  Projects  — timelines in Supabase (no media)     /api/media        → streams provider media
  Drive     — media in your own Drive              /api/google/*     → oauth2.googleapis.com
  Preview   — custom player over <video>             holds the refresh token, mints
  Export    — ffmpeg.wasm → MP4, captions burnt in   an access token per request

                                                 Supabase and Drive themselves talk to the
                                                 browser directly, not through us.
```

A few decisions worth knowing about:

**Why proxy at all?** For fal, secrecy: the key belongs to the deployment and is
attached on the way through, so it never exists in the browser. For ElevenLabs,
reliability — browser-direct calls depend on each provider's CORS policy, which
changes without notice, and going through our own origin makes it deterministic.
Both share a second payoff: provider media arrives same-origin, so it never
taints the canvas during export.

**Why the queue API, not the simple one?** A Netlify function may run for about
ten seconds; video generation takes minutes. So the browser drives the job —
submit, then poll — and every proxied request stays short.

**Ingest on arrival.** As soon as something is generated, its bytes are pulled
into IndexedDB and everything afterwards works from `blob:` URLs. That is what
makes the project survive a refresh and keeps export free of CORS surprises.

**One hook backs everything up.** Every panel already funnels new media through
`ingestBlob`, so Drive and the asset catalogue both attach to that single point
(`setIngestListener` in `src/lib/media.ts`) instead of to each generate button.
Nothing in the ingest path knows Google or Supabase exists, which is also what
keeps it testable.

**Local first, cloud second.** Every edit still writes to IndexedDB
synchronously, exactly as before; the Supabase push is a debounced follow-up.
That ordering is deliberate — the editor never waits on a network round trip,
and a dropped connection costs you sync, not work. The scheduler that does it
(`src/lib/sync/scheduler.ts`) is pure and tested directly, because its awkward
case — an edit made _while_ a save is in flight — is exactly the kind of bug
that only ever shows up as "my last change sometimes vanished".

**The timeline stores ids, not files.** A project document references assets by
id; the assets table maps those to Drive file ids. That indirection is what lets
a timeline be a few kilobytes and still describe hundreds of megabytes of media
well enough to rebuild it anywhere.

**A Drive credential never reaches local storage.** The access token lives in
memory for its hour and nowhere else. The refresh token that replaces it — the
part that is genuinely long-lived — is held server-side under a service role key
and swapped for an access token on demand, so the page never sees it. That split
is the whole design: everything the browser holds is short-lived and cheap to
replace, and the thing that is not, it cannot read. A deployment with no
server-side half configured has nowhere to keep a refresh token, so it does not
offer a connection at all rather than one that quietly dies within the hour —
the gate says which piece is missing. A connection that lapses later is caught
where it bites, next to the upload that failed; reloading returns you to the
Drive step, which by then says "Reconnect Google Drive" rather than pretending
this is the first time.

**Two trips to Google, and the second is not optional.** Signing in and
authorising Drive used to be one request (`response_type=code id_token`), which
returned proof of identity and a consent code together. Auth0 owns
the login now and has no way to add a scope to it, so Drive is asked for
separately. What is _not_ done is making it optional: a Drive grant that sits
switched off until someone finds a button in Settings is a backup that quietly
does nothing, so the gate asks for it before the editor opens and a site that
cannot store the result says so instead. `login_hint` carries the address across
from the first screen, which is what keeps the second one to a single question.

**The gate holds all three.** The editor does not mount until there is a
session, a Drive connection _and_ a folder — an editor that silently saves
nothing is worse than a prompt. But entry is latched: a grant revoked from
someone's Google account page an hour later shows up in Settings rather than
ejecting them from an open project.

**Tracks fill themselves in.** A new recording goes onto the first voice track
with a free gap at that moment, and only stacks a new lane when every existing
one is busy. So you can record the same passage twice, or talk over yourself,
and both survive — without ever having to think about which track you are on.
The rule is first-fit, and it lives in `src/lib/audioTracks.ts` as a pure
function so it can be tested directly.

**A cut is nothing but two clips.** Cutting splits the clip under the playhead
into two that carry on from each other, and that is the whole of it — no cut
list, no markers, no schema change. It saves and reloads because the timeline
does, and a project opened tomorrow shows its cuts because two clips meeting
mid-source _is_ a cut. The timeline recognises that and marks each one with a
dashed line, and the clip's ⋯ menu offers to join the halves back together,
which is as close as this editor gets to an undo. That lives on the menu rather
than in the seam because the seam already has a control in it — the `+` that
adds a transition — and two buttons a few pixels apart, one blending the shots
and the other undoing an edit, is a mis-click waiting to happen. Cuts snap to a
frame, and the frame lines drawn once you are zoomed in far enough are the same
grid — so the line you park the playhead on is the line the cut lands on. The
arithmetic is in `src/lib/timeline.ts` with the rest of the pure timeline maths.

**A transition is an overlap, so the timeline gets shorter.** A dissolve is the
tail of one shot playing at the same time as the head of the next — that is what
the word means — so both clips give up the length of it and the picture ends
earlier by exactly that much. The alternative, holding a frozen frame either side
to keep the running time, is a different effect that reads as two stills fading
into each other. So `layoutClips` pulls each clip back by its transition and
everything downstream simply follows: the preview draws both clips through the
overlap, the export hands the same two numbers to ffmpeg's `xfade`, and the
captions and takes anchored to a shot are carried along by the same code that
carries them through a trim. The overlap always ends precisely where the outgoing
clip does, which is what lets the two agree without either knowing about the
other.

**What a boundary can afford is worked out on the way out, not on the way in.**
Trim a clip shorter than its transition and the transition has to shrink; trim it
back and the transition should come back too — so what a clip stores is a wish,
and `fitTransitions` reconciles it against both neighbours every time the clips
are laid out. Nothing is written back, which is why a stray drag cannot quietly
destroy an edit, and why no code path anywhere can leave the timeline describing
an overlap the material cannot cover.

**Nine transitions, drawn twice.** Each one has to render in CSS for the preview
and as an `xfade` transition for the export, and `src/lib/transitions.ts` holds
both halves side by side so neither can drift. The picker's tiles are built from
that same CSS, frozen halfway through and using the two shots the boundary
actually joins — so a tile cannot promise something the playback will not do. Its
sound crosses over on the same linear ramp `afade` uses in the render, because
two takes playing flat out through a dissolve is a doubling you can hear.

**Overlaps are refused, not allowed.** Dragging a clip on top of another is a
no-op with a red outline rather than a silent collision, because two clips
stacked on one lane cannot both be heard and you would only find out on export.

**One gap, always at the front.** Visual clips sit end to end, so there is
nowhere to put something that has to happen _before_ the video — which is what a
count-in is. The lead-in is that one place: a number of seconds on the project
that slides the whole picture track later and fills the space with black. It
stays one number rather than becoming arbitrary gaps between clips, so nothing
about trimming, cutting or reordering changes; `layoutClips` applies it, and
everything built on those positions — what is on screen, where a cut lands, how
long the render runs — moves with the picture instead of some of it being left
behind. The export does it with `tpad=start_mode=add`, which pads the front of
the concatenated picture rather than adding an input to composite. Audio does
not move: its start times are already absolute, and that is precisely what lets
the beeps play over the black. A clip's own sound _does_ move, because it is
locked to its picture and always was.

**The count-in is three sine bursts, not a file.** `src/lib/countdown.ts`
synthesises the beeps into a WAV in about a millisecond, which is cheaper than
shipping an asset and finding out at export time that it never made it into the
build — and it makes the timing exact: a beep on each whole second, then silence
to the mark, so the _end_ of the clip is the moment to come in on. From there it
is ordinary audio on an ordinary track: it plays in the preview while you record,
it drags to the frame you want, and the exporter mixes it into the MP4 with
everything else, so whoever performs to the finished video hears the same
count-in you did. It gets a lane of its own for two reasons — a cue you are
trying to place to the exact second should never be blocked by a take that
happens to sit under it, and one mute button should be enough to leave the beeps
out of a particular export. The beeps are generated at half scale, because the
mixer sums tracks without normalising and a cue at full level would clip
whatever it counts into.

**Clips keep their own sound.** A video that arrives with audio — filmed
footage from Drive, or a model that returns sound — plays it in the preview and
mixes it into the export, locked to its picture, with a mute and a level on the
clip itself. What makes that safe is that nothing is assumed: naming an audio
stream that is not there fails the whole render, so the exporter asks ffmpeg
what each file actually contains before it builds the graph
(`src/lib/export/probe.ts`). Preview and export always agree; hearing something
in one that vanishes from the other would be worse than silence.

**The waveform lane is a view, not a track.** A clip's sound belongs to its
clip — trimmed with it, mixed where it sits — so drawing it under the picture
answers "where does anyone actually speak" without pretending it is something
you can drag. Peaks are computed once per asset, at a magnitude for every
hundredth of a second, and everything after that is a slice of that one array:
a trim moves the waveform with the picture, both halves of a cut already have
their peaks, and zooming redraws without touching the file. What is kept is the
peaks, a few kilobytes, not the decoded buffer, which for a minute of stereo is
ten megabytes. It is drawn on a square-root scale rather than straight
amplitude — speech at a sensible level peaks around a tenth of full scale, which
in a lane this size is one pixel and reads as silence — and deliberately not
normalised per clip, which would make two clips look equally loud however far
apart their levels really were. A file that will not decode, or has no audio at
all, draws the centre line and nothing else: a waveform is a convenience and
must never be why an edit fails.

**Fullscreen takes the player, not the video.** The preview is a stack of media
elements chased to a clock above them, so handing one `<video>` to the browser's
own fullscreen would show a single clip, drop the audio layered over it, and
leave nothing to press. The button — or the `F` key — takes the whole player
instead: picture, audio elements and transport together, with nothing remounted
on the way in, so playback carries straight on across the transition. Leaving is
usually not our doing, since Escape and the browser's own chrome both exit
without asking, so the button reads its state back off the document rather than
tracking it. Where fullscreen is refused outright — an iframe without
`allow="fullscreen"`, or an iPhone, where only a bare `<video>` can do it — the
button is absent rather than present and broken.

**Captions are words, not lines.** A caption holds a list of words, each with
its own start and end in absolute timeline seconds — not offsets into the
caption, which would leave two representations to fall out of step every time
something moved. That single choice is what makes the rest work: the word being
spoken at any moment is a lookup, moving a caption moves its words with it, and
retiming one word is an edit to that word alone.

**Captions are part of the document, not a table beside it.** Words with their
own timings go into the same jsonb blob as the clips, save on the same
two-second debounce, and come back with the project on any machine you sign in
from. Rows would mean one per spoken word, order-significant, rewritten wholesale
every time a line is retyped — for data that is only ever read as a whole. The
keys are written only when there is something in them, so a project with no
captions saves exactly the document it always did, and deleting the last caption
removes them again rather than leaving an empty list behind.

**One transcriber, chosen for one property.** Captions are written by
ElevenLabs Scribe v2, reached through fal — `src/lib/scribe.ts`. It is not
offered as a choice, and that is the point: it is here because it returns a
timestamp on every _word_, which is the whole requirement for karaoke captions. A
transcript with only sentence-level timings would have its word timings guessed,
and guessed word timings are exactly what a highlight moving across a line makes
obvious. A cheaper model without that property would not be a cheaper
alternative, it would be a different feature.

Through fal rather than through ElevenLabs directly because that is where this
app's other model calls already go, and the difference is who pays: the fal key
belongs to the deployment and is attached inside the proxy, so captions need no
key from the user and work on a first visit with nothing entered. The user's own
ElevenLabs key is now only the voice changer.

**What is sent is the audio, not the video.** The browser decodes each source and
re-encodes exactly the stretch a clip actually uses as mono 16kHz WAV, which is
what separates the audio from the picture — a decoded MP4 is samples like
anything else, so no demuxing step is needed and no container has to be
understood. Downsampling loses nothing a speech recogniser was listening to, and
it makes the request size predictable rather than dependent on how a provider
happened to encode a clip. That matters because the audio travels to fal as a
base64 data URI inside the JSON body, and base64 costs a third again on top of
the 32KB a second above.

A data URI rather than an upload, and that is a choice rather than a shortcut.
fal takes a file input three ways — a public URL, a data URI, or a file put into
its own storage with `fal.storage.upload` — and the last of those is the one its
docs recommend. It wants credentials in the browser, which is the whole thing
this app's proxy exists to avoid, and it leaves the audio sitting at a publicly
reachable URL afterwards. Someone's voiceover is not ours to park somewhere
public. A data URI exists for the life of the request and nowhere else. fal's
own caveat is that large files sent this way cost request performance, which is
the other half of the reasoning below.

So `CHUNK_SECONDS` in `src/lib/speechAudio.ts` is set at 75 — 2.4MB of audio
arriving as about 3.2MB of request, well inside the 6MB serverless payload
ceiling. Deliberately well inside rather than exactly at it, because the proxy
re-encodes the body on its own way through. Chunk boundaries are blunt, so a word
straddling one is split; most short-form takes are shorter than a chunk and go in
one piece with no seams at all. `chunkRanges` is pure and is where the arithmetic
that has to line back up lives.

**`words` does not mean words.** Scribe's list interleaves the words with the
spacing between them, each entry tagged `word`, `spacing` or `audio_event`:

    { "text": "Hey,", "start": 0.079, "end": 0.539, "type": "word" }
    { "text": " ",    "start": 0.539, "end": 0.599, "type": "spacing" }

Taking the list as it comes puts a caption on screen for every gap between two
words. `wordsFromScribe` is the one function in that file with any judgement in
it and is where the tests are, against a real response kept verbatim. Words with
no timing are dropped rather than defaulted to zero — a word with no time cannot
be highlighted at the right moment, and one silently pinned to the start of the
clip is worse than one that is missing.

**Two of the defaults are turned off.** `tag_audio_events` and `diarize` both
default to _true_, and both produce something captions discard: audio events are
description rather than speech, and a speaker label has nowhere to go in a
karaoke line, where one word is lit and nobody is credited. Left alone they would
be work asked for, paid for and thrown away. `keyterms` — which biases the model
towards a word list for a 30% premium — is absent rather than sent empty, so it
stays a thing to add knowingly. `scribeInput` is pure and tested for exactly
this: the defaults are the kind of thing that silently comes back.

**The panel folds up around the transcript.** Setup and styling are cards you
use once; the transcript is where the rest of the session happens. Both close
themselves as soon as there is a transcript to make room for, and each keeps a
summary in its header so the state is legible without opening it. Which card is
open is a view preference and deliberately not saved — a fresh load starts
compact however it was left.

The related bug is worth naming, because it is a trap: the transcript follows
playback by scrolling the caption being spoken into view, and `scrollIntoView`
walks _every_ scrollable ancestor. The step panel sits inside one, so following
the playhead dragged the whole page down once per caption. It now adjusts the
list's own `scrollTop` and touches nothing else.

**Word timing is editable from the timeline, not only the transcript.** Each
word has a handle where its highlight begins: a 16px target around a 4px tick,
because the tick has to be thin to say precisely _when_ and a 4px-wide button is
a thing you hunt for rather than grab. Arrow keys nudge the selected word by a
hundredth of a second — finer than a pixel of drag at any usable zoom, and the
only way to place a word exactly rather than approximately.

The block divides top to bottom: the line and its trim edges above, the word
handles along the bottom. That split is load-bearing. The edges used to span the
full height, and since the first word of a caption starts at the cue start by
definition, its handle sat underneath one and could never be grabbed at all.

**Every caption remembers where it was heard.** A cue carries a `source` — the
id of the clip it was transcribed from, plus that clip's name as it was at the
time. It is stamped in `wordsOntoTimeline`, which is the only point that knows
both the words and the clip they came from; a moment later they are sorted in
among every other source's and the connection is gone for good.

Worth keeping because the timeline deliberately allows takes to be layered over
the same seconds, and once their words are on one caption lane nothing else
distinguishes them. A caption that runs across a cut is credited to the clip it
_begins_ in, which stays stable when the words either side are re-edited, and
splitting a line gives both halves the same source. The label is a snapshot
rather than a lookup, so a caption whose clip has since been deleted still says
where it came from instead of holding a dangling id.

**One clip can be redone on its own, and that is what the source is for.** The
common failure is not a bad transcript, it is one bad take among several good
ones — and the whole-timeline button answers it by re-transcribing everything
you already paid for and throwing away every correction you made.

So captioning one clip is offered on the clip, in the ⋯ menu every clip carries,
priced on the row: _Generate captions for this clip · ~$0.01_. That is where the
press belongs, because that is where you are looking at the moment you notice the
problem — the caption on the lane says which clip it was heard in, and the clip
it names is a few pixels away. Four panels away in the Captions step, the same
control would be a list of clip names to match up by hand. It says _redo_ rather
than _generate_ once a clip has captions, since that press is going to take
something away as well as add something.

`recaptionSource` in `src/lib/captions.ts` does the swap: cues stamped with that
clip are dropped, the fresh ones take their place, and every other line survives
as the very same object it was — which is how a hand-typed word on another clip
is guaranteed to still be there afterwards, rather than merely likely to be. A
caption that claims no source at all — typed by hand, or made before provenance
was recorded — belongs to nobody and is never swapped out.

The fresh captions defer to the ones that stayed: each is pulled inside the room
its neighbours leave, and one with no room at all is dropped and reported rather
than laid over a caption from another clip. That is the same resolution
`dedupeOverlappingWords` makes when both clips are transcribed at once, so
layered takes come out the same way whichever button was pressed. And a clip
that fails to transcribe keeps the captions it has: a network fault is a reason
to press it again, never a reason to lose words that were already right.

**A clip's menu is drawn outside the timeline it belongs to.** The lanes scroll
horizontally, and a scroll container clips both axes — a menu drawn inside one is
cut off at the edge of its own track. So `ClipMenu` renders into `document.body`
and positions itself against the button, flipping above when there is no room
below. The cost of being outside is that it cannot move with its clip, which is
why any scroll closes it: a menu left hanging over a clip that has slid away is
pointing at the wrong one.

The job itself lives in `useCaptionJobStore` rather than in the menu, because it
outlives it — the menu closes on the click and the words arrive seconds later, so
the result is reported next to the timeline instead, where the press happened.
That store also holds the spoken language, so a clip redone from the timeline
cannot come back transcribed as a different language than the rest.

**One highlight, one definition.** `wordSpans` in `src/lib/captions.ts` says
which stretch of time each word owns; a word stays lit until the next one
starts, so the highlight never blinks out in the pause after a word. The preview
reads that function to colour a `<span>`, and the exporter turns each span into
one subtitle event. There is no second copy of the rule, so the burnt-in
captions cannot drift from the ones you edited.

**Karaoke is not ASS karaoke.** ASS has `\k` tags of its own and they do the
wrong thing: they fill a line progressively, leaving every word already sung in
the highlight colour. What short-form captions mean by karaoke is one word lit
at a time. So `src/lib/export/assCaptions.ts` writes one event per word, each
carrying the whole line with only that word recoloured — identical text every
time, so the line cannot re-wrap or shift as the highlight travels across it. A
minute of speech is a couple of hundred events, which libass renders without
noticing.

**The caption font is shipped, not chosen.** ffmpeg.wasm has no system fonts at
all, and libass asked to draw without one renders nothing while still exiting
successfully — an export that quietly loses its captions. So the typeface is a
file: Lindy Toon Wide, checked in under `assets/fonts/`, staged into
`public/fonts/` at build time by `scripts/copy-caption-font.mjs`, served from
this origin, and handed to ffmpeg in its own virtual directory. The preview
loads that same file through `@font-face`, which is the point — what you
position over the picture is drawn with the very bytes that end up in the MP4.

It ships one weight, and captions default to it rather than to bold. Bold is
still a toggle, but with no bold face to reach for both sides fake it — the
browser strokes the outline, libass emboldens the glyph — and the two are not
the same approximation. Leaving the default at the weight that exists is the
only setting where the preview and the export are the same drawing. It is also
an all-caps face: lowercase codepoints map to the capital glyphs, so the
uppercase toggle changes the transcript that is drawn, not the letterforms.

**Sizes are fractions of the frame.** A caption's size, outline and height are
stored as fractions rather than pixels, because the export resolution is chosen
in the export dialog long after the captions were styled. The ASS file is
authored at the output size with those fractions applied, so there is no scaling
factor anywhere to get wrong.

**Editing the transcript keeps the timings.** Retyping a word is the
overwhelmingly common edit, so `setCueText` matches the new words to the old
ones by position: fix a misheard word and every timing in that line — and every
word id, so your selection survives — is exactly as it was. Words with no
counterpart get an even share of the time left over, and a line emptied
altogether stops being a caption rather than sitting on screen blank.

**Only one thing can be said at once.** Takes layer, so recording a line twice
leaves both audible and both transcribed, and merging them word for word gives
"This This is is". Since only one word can be highlighted, only one can be
captioned: overlapping words are resolved in favour of whichever source comes
first, which is the order the panel reports progress in and the order a mute
button changes. Captions on a track are kept from overlapping for the same
reason a second audio clip may not share a lane.

**Transcription is 16kHz mono, cut into chunks.** Whatever the source — WebM
from the recorder, MP4 from a model, an MP3 someone dropped in — the browser
decodes it and re-encodes exactly what a speech recogniser wants. That avoids
teaching the provider about every container, and it makes the request size
predictable, which matters because the proxy in front of it is a serverless
function with a payload ceiling. At 32KB a second, two minutes fits comfortably;
anything longer is transcribed a chunk at a time and stitched back together
(`src/lib/speechAudio.ts`).

**Captions are burnt in after the lead-in.** Cue times are absolute timeline
seconds, and it is the `tpad` that opens the black at the front which makes the
stream's own clock agree with the timeline. So the `ass` filter goes last in the
chain: burning captions in before the padding would date them from the first
frame of picture instead, putting every one of them late — and losing outright
any caption written over the lead-in, which is exactly where narration over
black lives.

**Model IDs live in one file.** Provider catalogues change every few weeks, so
`src/lib/models.ts` holds every ID the app depends on and each picker has a
custom-ID box. When something goes stale, the provider's error shows verbatim
and the fix is one line — no code change and no waiting for a release.

## Testing

```bash
npm test          # unit tests — timeline maths, caption grouping and retiming,
                  # the karaoke subtitle file, reading Scribe's word list, ffmpeg
                  # argv, SSRF guard, session
                  # verification and persistence, the Drive connection flow, the
                  # video request body, orientation, key storage
npm run lint
npm run build

# end-to-end, in a real browser, no keys required
npm run build:mock
npm run preview &
npx playwright install chromium   # once
npm run test:e2e
```

The unit tests concentrate on the pure logic where the real bugs live:
`src/lib/timeline.ts` (clip layout, trim clamping, frame snapping and the rule
that the two halves of a cut still add up to the clip they came from),
`src/lib/audioTracks.ts` (track assignment, overlap rules, migration of
pre-multitrack projects),
`src/lib/countdown.ts` (a beep on each second, silence to the mark, headroom
left in the mix, and a WAV header whose declared sizes match the samples — the
usual way to produce a file that plays for a moment and then stops),
`src/lib/waveform.ts` (peak bucketing, the slice a trimmed clip shows, and the
rule that squeezing a waveform into fewer pixels keeps the loudest bucket rather
than averaging the transients away) and
`src/lib/export/buildGraph.ts` (the exact ffmpeg arguments, asserted without
running ffmpeg). `netlify/lib/proxy.test.ts` covers the media proxy's
allowlist, including the cloud-metadata address and lookalike hostnames.

Several exist because the bug they guard against is invisible until you close
the tab or lose a token. `src/state/useAuthStore.test.ts` restores a sign-in
against a mocked Auth0 client, since persisting the session is auth0-spa-js's
job rather than ours.
`src/lib/supabase/session.test.ts` holds the caching that keeps every Supabase
query from minting a session of its own, and keeps "your session lapsed" apart
from "this site was never finished". `netlify/lib/supabaseToken.test.ts` mints a
token and feeds it to the real `requireSession`, because a token nobody accepts
looks exactly like a user who is not signed in.
`src/lib/google/oauthPopup.test.ts` and `identity.test.ts` pin the parameters
the Drive grant rests on — `access_type=offline` and `prompt=consent` for a
refresh token that outlives the tab, `login_hint` so the second consent screen
does not also ask which account, and the Drive scopes actually reaching the
request. And `src/components/SignInGate.test.tsx` holds the gate rules that
decide whether anyone can use the app — no entry without Drive, no Drive prompt
before there is an account to file it under, and no ejection once inside.

`e2e/smoke.mjs` walks the whole product — including recording two overlapping
takes and checking that the second one lands on a new track, cutting a clip and
reloading the page to see the cut come back, putting a count-in in front of the
video and then dragging both it and the picture's lead-in, and counting the inked
pixels in the waveform lane, since an undecoded file leaves a canvas that looks
fine and shows nothing — then parses the
exported MP4 to confirm it has the tracks it should and runs for exactly as long
as the export dialog promised, which is how the black at the head is known to
have been encoded rather than merely requested. It earns its keep: it is
what caught the ffmpeg core being loaded as UMD when Vite's module worker needs
ESM. The reload is there because the round trip through IndexedDB is the one
part of persistence a unit test cannot stand in for.

If your CI image ships its own browser, point the test at it with
`CHROMIUM_PATH=/path/to/chrome`.

## Known limits

- **Getting in costs two trips to Google.** One signs you in through Netlify
  Identity, the other grants Drive, because an Identity login cannot carry a
  Drive scope. The second is asked with the first one's address as a hint, so it
  is one question rather than two — but it is still a second screen, and it was
  one before Auth0 took the login back to a single screen.
- **A clip's sound cannot be moved off its clip.** It is mixed where the clip
  sits and trimmed with it, which is what you want for filmed footage; but there
  is no way to slide it, keep it running under the next clip, or drop it onto an
  audio track as its own layer. The clip sound lane shows you where it is; it
  does not let you take it anywhere.
- **Only video clips get a waveform.** The audio tracks show named blocks rather
  than their contents, and a clip whose file this browser cannot decode shows an
  empty lane rather than an error.
- **Audio clips cannot be trimmed from the timeline.** They can be retimed and
  moved between tracks, but shortening a take means re-recording it.
- **A cut cannot leave a sliver.** Both halves have to clear 0.2s, the same floor
  trimming works to, so the last few frames of a clip cannot be split off as a
  clip of their own — drag its edge instead.
- **Captions are burnt in, and only burnt in.** There is no sidecar `.srt` or
  `.vtt` to export, and no way to turn them off in a player once rendered — a
  karaoke highlight is not something a subtitle track can carry. Hide the
  caption track before exporting to get a version without them.
- **Transcription needs the speech to already be on the timeline.** Voice tracks
  and the sound video clips carry are transcribed; music and count-in lanes are
  not, and a muted track is skipped, because its words are not in the finished
  video either.
- **The free transcriber is slower and less accurate**, which is the trade. It
  downloads the model the first time — 80MB or several times that, depending on
  which format your browser will actually run — then runs on your CPU at roughly
  the length of the audio again, and mishears more than the paid one,
  particularly accents, crosstalk and noise.
  The transcript is editable precisely because no transcriber is right every
  time. It also needs to reach huggingface.co once to fetch the model; after that
  it works offline, and it never sends your audio anywhere at all.
- **The in-browser model is single-threaded and CPU-only.** Threads would need
  cross-origin isolation, which would block loading provider media in the page,
  and WebGPU would be a second execution path reachable on only some machines.
  Both are the same trade the exporter already makes.
- **Redoing captions replaces them.** Transcribing again is how you redo a bad
  take, so it discards whatever was edited by hand on that track rather than
  trying to merge two transcripts. Redoing a single clip narrows that to the
  clip — every other caption survives, including the corrections in it — but
  within that clip it is still a replacement, not a merge. It is on the clip's
  own ⋯ menu on the timeline, not in the Captions step.
- **A redone clip gives way to the captions around it.** Its new lines are
  fitted into the room its neighbours leave, and one that would land squarely on
  a caption from another clip is left out and said so, since only one caption
  can be on screen at a time. Redo the whole timeline if the clips themselves
  have been moved on top of each other.
- **Export uses the single-threaded ffmpeg build**, so a short project takes
  roughly 30–90 seconds. The multithreaded build needs cross-origin isolation
  (COOP/COEP), which would block loading provider media in the page.
- **A transition is capped at two seconds, and at the shorter of its clips.**
  Both of them give up that much material, so a boundary can only hold what its
  neighbours can spare — and a clip caught between two transitions has to cover
  both, which is why the second one shrinks or disappears when the first grows.
  The picker says what the boundary has room for.
- **Transitions belong to the picture track.** Clips on a video lane are laid
  over the picture rather than into it, so they have no boundary to put one at;
  fade one in by dropping its lane's opacity instead. There is also no cutting
  inside a transition — those frames are already being blended with a
  neighbour's.
- **One picture track.** This is deliberate — visual clips sit end to end with no
  gaps, which removes most of what makes a timeline confusing. Audio is the part
  that genuinely needs layers, so that is where the multiple tracks are. The only
  text over the picture is captions, which are not free-placed titles: they are
  the words that were spoken, laid out by one style per track.
- **The only gap is the lead-in, and it is at the front.** You can slide the
  whole picture track later to open black in front of it, but there is no way to
  leave a hole between two clips, or to start the picture before an earlier one
  has finished.
- **A lead-in does not carry the audio with it.** Adding one after a voiceover
  is placed moves the picture out from under it; the takes stay where they are
  and have to be dragged. That is what makes the count-in possible, but it does
  mean the order to work in is lead-in first, narration second.

## Licence

MIT
