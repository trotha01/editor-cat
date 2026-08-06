# editor-cat

A small AI video editor that runs in your browser.

Write a prompt → get images → animate one into a clip → arrange clips on a
timeline → layer voiceovers and music → swap your voice for another one → export an MP4.

Images and video are generated on the deployment's own fal.ai account, so
visitors need no key for them. Voice conversion still uses **your own
ElevenLabs key**, held in your browser.

---

## What it does

| Step          | What happens                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · Image** | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                                            |
| **2 · Video** | Pick a generated image as the opening frame and animate it with Seedance 2.0 at 480p. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame. |
| **Timeline**  | Drag clips to reorder, drag their edges to trim, set how long stills stay on screen. Audio sits on its own stacked tracks below.                                                                                   |
| **3 · Audio** | Record as many voiceover takes as you like — they layer onto separate tracks automatically. Add music that sits under them. Convert any take into another voice with ElevenLabs; the original is always kept.      |
| **Export**    | Render an MP4 in the browser with ffmpeg compiled to WebAssembly. Nothing is uploaded.                                                                                                                             |

## What you need

**As a visitor:** nothing, unless you want voice conversion. Image and video
generation run on the site's own fal.ai account.

- **[ElevenLabs](https://elevenlabs.io)** — entered in **Settings**, and only for changing your recorded voice. Everything else works without it. It is held in your browser: tick _remember on this device_ and it goes into local storage, leave it off and it is gone when you close the tab. Either way it is attached to each request as it passes through this site's proxy, and is never written to a server or a log.

**As whoever deploys it:** a [fal.ai](https://fal.ai/dashboard/keys) key set as
`FAL_KEY` in the site environment. See [Deploying to Netlify](#deploying-to-netlify).

**Costs are real, and they land on the deployment.** Images are roughly
$0.003–$0.04 each; video is roughly $0.04 per second at 480p on the default
model, rising to $0.40 on the most expensive one in the picker. The app shows an
estimate before every generate button, because a mis-click on a video model is
expensive.

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

### Trying it without any keys

```bash
VITE_MOCK_PROVIDERS=1 npm run dev
```

Mock mode fakes every provider call locally and needs no keys and no network.
The media it produces is real — images are drawn on a canvas and videos are
recorded off an animated one — so the timeline, preview and export all get a
genuine workout. This is also what the end-to-end test drives.

## Saving projects (optional)

With a Supabase project configured, the app asks you to sign in with Google and
then keeps your timelines in your account: a project switcher in the header,
auto-save about two seconds after you stop editing, and projects that open on
any machine you sign in from.

**Signing in is the only Google prompt.** One consent screen covers both halves
of what the editor needs: who you are, and permission to write to your Drive.
There is no second connection step anywhere. What follows it is a screen of our
own — which folder your media goes into — and after that the editor. Settings
keeps the folder and the sign-out, and nothing else about Google.

Because that one screen has to do both jobs, sign-in needs the two server-side
variables under [what the sign-in needs](#what-the-sign-in-needs). Without them
the site cannot sign anyone in at all, and says so rather than falling back to
asking for Google twice.

**What lives where.** Supabase holds the timeline — clips, tracks, trims, audio
placement, resolution — and a catalogue of asset metadata. It never holds media
bytes. Those are in your Google Drive, and cached in each browser's IndexedDB.
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
   holds Google refresh tokens, which no browser can read at all — sign-in does
   not work without it, so it is not optional.
3. **Authentication → Providers → Google → Enable**, and paste the _same_ Google
   client ID from the Drive setup above into **Authorized Client IDs**. No
   client secret is needed here: the page hands Supabase a Google ID token it
   already holds, rather than sending the browser through Supabase's own
   redirect. (The secret in `GOOGLE_CLIENT_SECRET` is a different thing — it is
   read only by this site's own function, to obtain that token and a Drive
   refresh token together.)
4. Copy the project URL and anon key from **Project settings → API** into `.env`
   (and into Netlify's environment variables), then redeploy.

The client ID must match in both places. If it does not, sign-in fails with
"Unacceptable audience" — the app rewrites that message to say so, because the
raw error points at nothing.

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

### Conflicts

Each project row carries a version. A write only lands if the version still
matches what this session last saw, so editing the same project in two tabs
shows "Changed elsewhere" rather than one tab silently overwriting the other.
Resolution is a reload — merging two timelines has no sensible automatic answer.

## Saving to your own Google Drive (optional)

Drive comes with the sign-in, and the step straight after it is choosing where
your media goes: make an `editor-cat` folder in one click, or pick an existing
one. From then on everything the app makes — generated images, rendered clips,
recordings, files you upload — is copied into that folder as it is created, and
**Library → Import from Drive** opens the Google Picker inside it to bring
existing media in.

The editor does not open until all three are in place — session, permission,
folder — because an editor that silently saves nowhere is worse than one more
click. Declining the Drive permission on Google's own consent screen therefore
sends you back to the same button, with a way to switch accounts.

**Signing out** is in Settings, under Account. It leaves your projects and your
media where they are and clears this browser: the Google permission held in
memory, and the folder new media was being saved into. Signing back in is the
same single prompt.

The bytes stay in IndexedDB either way; Drive is the durable copy, not the
playback source. Drive has no URL that carries our token _and_ serves range
requests, so a `<video>` pointed straight at it could not seek — and export
needs the bytes locally regardless. A failed upload therefore costs you the
backup and nothing else.

`VITE_GOOGLE_CLIENT_ID` is what turns all of this on. Left unset, there is no
sign-in and no Drive; the app runs against this browser's storage alone.

### Setting up the client ID

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen**. While it is in _Testing_ you can add
   up to 100 test users and nothing further is required.
3. Enable the **Google Picker API** as well — it is what chooses folders and
   imports media.
4. Create an **OAuth client ID** of type _Web application_. Add your origins to
   **Authorised JavaScript origins**: `http://localhost:5173` for `npm run dev`,
   `http://localhost:8888` for `netlify dev`, plus your deployed URL.
5. Add the same origins with `/oauth/google` on the end to **Authorised redirect
   URIs** — `http://localhost:8888/oauth/google`, `https://your-site/oauth/google`.
   That is where the consent pop-up lands. Google compares it byte for byte, so
   no trailing slash, and sign-in fails without it.
6. Create an **API key** under the same credentials page, restricted by HTTP
   referrer to your origins. The Picker will not open without one.
7. Put all three in `.env` locally, and in Netlify under **Site settings →
   Environment variables** (they are read at build time, so redeploy after
   adding them):

```
VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=AIza...
VITE_GOOGLE_PROJECT_NUMBER=1234567890   # Cloud console → project number
```

None of these is a secret — they ship in the bundle by design, and origin and
referrer allowlisting are what protect them. The project number is passed to the
Picker as its app id, which is what Google requires for files picked there to
stay reachable under `drive.file`.

### What the sign-in needs

Google's browser-only libraries cannot do this, so these two variables are
required — not optional extras.

Set them:

```
GOOGLE_CLIENT_SECRET=            # same OAuth client as the ID above
SUPABASE_SERVICE_ROLE_KEY=       # Supabase → Project settings → API
```

Both are genuinely secret, so mark them as such and **scope them to Functions**
— they are read at request time, not at build time. The `VITE_` variables are the
opposite: they are inlined into the browser bundle by design, so marking one
secret makes secrets scanning fail the build. If sign-in is refused after setting
these, the function log for `/api/google/status` names exactly which half is
still missing.

Then run `supabase/migrations/0002_google_connections.sql`, the same way as the
first migration.

**One consent screen instead of two.** Google Identity Services splits its two
jobs across libraries that cannot do each other's: `google.accounts.id` issues
the ID token that proves who you are, and `google.accounts.oauth2` grants Drive.
Using both means asking twice for what a user experiences as one decision — and
a backup that quietly does nothing until they find the second button. The plain
OAuth endpoint has no such split: asking for `response_type=code id_token`
returns both from one screen. That code is what needs the client secret to
exchange, which is why sign-in depends on it.

**A connection that outlives the tab.** The browser-only flow hands back an
access token and no way to renew it, so a Drive connection lasted about an hour
and a reload asked you to reconnect — and browsers are steadily closing the
loophole that let the renewal happen invisibly. The code returned above is
exchanged by `/api/google/*` for a refresh token, written to
`google_connections`, and never sent to the browser. What the page holds is the
same hour-long access token it always had; when that expires it asks the function
for another. The connection belongs to the account, so it also comes back on any
machine you sign in from.

**Why a service role key.** The table has row-level security enabled and no
policies at all, so no browser can read it whatever token it presents — not even
its owner's. The service role bypasses RLS, and that key exists only in the
function environment. A refresh token is a standing key to someone's Drive, and
this is what keeps it from being readable by anything running on the page.

Without both variables the sign-in screen says the site is not set up and names
what is missing. That is deliberate: the alternative was a second Google prompt
buried in Settings, and one prompt was worth more than the fallback.

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

If you are using the Drive integration, set `VITE_GOOGLE_CLIENT_ID` in the
site's environment variables and add the deployed origin to the OAuth client's
authorised origins.

### The one secret this needs

Set **`FAL_KEY`** in the site's environment variables, for **all deploy
contexts** — scoped to production only, every deploy preview answers 503. No
`VITE_` prefix: that would inline it into the browser bundle and publish it.

Then decide who is allowed to spend it. `/api/fal/*` generates video on your
account, so it verifies the caller's Supabase session before attaching the key:

- **The project URL** — already set as `VITE_SUPABASE_URL` for the browser, and
  the functions read that same value, so there is normally nothing to do here.
  Set `SUPABASE_URL` only to point the server at a different project. Tokens are
  verified locally against the project's published signing keys — no round trip
  per request, which matters because a single video job polls for minutes. Add
  `SUPABASE_JWT_SECRET` too if your project still signs with a shared secret.
- **With no project URL under either name, the proxy refuses every request** rather than running
  open. `FAL_PROXY_ALLOW_ANONYMOUS=1` overrides that for local `netlify dev`;
  setting it on a deployed site hands your fal credits to anyone who finds the
  URL. Netlify's own password protection or access controls are worth adding on
  top if the site is not meant to be public at all.

`VITE_GOOGLE_CLIENT_ID` and the two `VITE_SUPABASE_*` variables are build-time
and not secret — the anon key is protected by row-level security, and the client
ID by origin allowlisting.

Two more are **required if you want anyone to be able to sign in**:
**`GOOGLE_CLIENT_SECRET`** and **`SUPABASE_SERVICE_ROLE_KEY`**. The single
consent screen returns a code that only they can exchange. See
[what the sign-in needs](#what-the-sign-in-needs).

## How it fits together

```
Browser (React + TypeScript + Tailwind)      Netlify Functions (stateless pass-through)
  Settings  — one key, in memory or local       /api/fal/*        → queue.fal.run
  Generate  — images, then image → video          session verified, site's key attached
  Library   — blobs in IndexedDB                /api/elevenlabs/* → api.elevenlabs.io
  Timeline  — one picture track + N audio tracks  the caller's own key, forwarded once
  Projects  — timelines in Supabase (no media)  /api/media        → streams provider media
  Drive     — media in your own Drive           /api/google/*     → oauth2.googleapis.com
  Preview   — custom player over <video>          holds the refresh token, mints
  Export    — ffmpeg.wasm → MP4                   an access token per request

                                                Supabase and Drive themselves talk to
                                                the browser directly, not through us.
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
replace, and the thing that is not, it cannot read. Where a deployment has no
server-side half configured there is no refresh token at all, and a connection
lasts the hour; when it lapses, Settings offers a Reconnect button rather than
throwing an error at whatever you were doing.

**One trip to Google, not two.** Signing in and authorising Drive are one
request (`response_type=code id_token`), so the user makes one decision and the
app gets both an ID token and a consent code out of it. The alternative was two
libraries that cannot do each other's job, two consent screens, and a Drive
backup that sat switched off until someone found the button in Settings. That
fallback is gone rather than kept as a degraded mode: a site missing the client
secret refuses to sign anyone in, because half a sign-in is not worth the second
prompt.

**The gate holds both.** The editor does not mount until there is a session _and_
a Drive connection — an editor that silently saves nothing is worse than a
prompt. But entry is latched: a grant revoked from someone's Google account page
an hour later shows up in Settings rather than ejecting them from an open
project.

**Tracks fill themselves in.** A new recording goes onto the first voice track
with a free gap at that moment, and only stacks a new lane when every existing
one is busy. So you can record the same passage twice, or talk over yourself,
and both survive — without ever having to think about which track you are on.
The rule is first-fit, and it lives in `src/lib/audioTracks.ts` as a pure
function so it can be tested directly.

**Overlaps are refused, not allowed.** Dragging a clip on top of another is a
no-op with a red outline rather than a silent collision, because two clips
stacked on one lane cannot both be heard and you would only find out on export.

**Clip audio is muted.** The exporter mixes only your audio tracks, so the
preview mutes video clips to match. Hearing something in preview that vanished
from the export would be worse than silence.

**Model IDs live in one file.** Provider catalogues change every few weeks, so
`src/lib/models.ts` holds every ID the app depends on and each picker has a
custom-ID box. When something goes stale, the provider's error shows verbatim
and the fix is one line — no code change and no waiting for a release.

## Testing

```bash
npm test          # unit tests — timeline maths, ffmpeg argv, SSRF guard, session
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
`src/lib/timeline.ts` (clip layout, trim clamping), `src/lib/audioTracks.ts`
(track assignment, overlap rules, migration of pre-multitrack projects) and
`src/lib/export/buildGraph.ts` (the exact ffmpeg arguments, asserted without
running ffmpeg). `netlify/lib/proxy.test.ts` covers the media proxy's
allowlist, including the cloud-metadata address and lookalike hostnames.

Four of them exist because the bug they guard against is invisible until you
close the tab or lose a token: `src/state/useAuthStore.test.ts` signs in against a
real Supabase client with a seeded local storage; `src/lib/google/oauthPopup.test.ts`
and `identity.test.ts` pin the parameters the whole thing rests on —
`access_type=offline` and `prompt=consent` for a refresh token that outlives the
tab, `response_type=code id_token` for the single consent screen, and the Drive
scopes actually reaching the request; and `src/components/SignInGate.test.tsx`
holds the two gate rules that decide whether anyone can use the app — no entry
without Drive, and no ejection once inside.

`e2e/smoke.mjs` walks the whole product — including recording two overlapping
takes and checking that the second one lands on a new track — then parses the
exported MP4 to confirm it has the tracks and duration it should. It earns its
keep: it is what caught the ffmpeg core being loaded as UMD when Vite's module
worker needs ESM.

If your CI image ships its own browser, point the test at it with
`CHROMIUM_PATH=/path/to/chrome`.

## Known limits

- **Audio from video clips is not exported.** Most image-to-video models return
  silent footage, and mixing per-clip audio requires knowing which files have an
  audio stream at all. Your audio tracks are the soundtrack.
- **Audio clips cannot be trimmed from the timeline.** They can be retimed and
  moved between tracks, but shortening a take means re-recording it.
- **Export uses the single-threaded ffmpeg build**, so a short project takes
  roughly 30–90 seconds. The multithreaded build needs cross-origin isolation
  (COOP/COEP), which would block loading provider media in the page.
- **One picture track, no transitions or text overlays.** This is deliberate —
  visual clips sit end to end with no gaps, which removes most of what makes a
  timeline confusing. Audio is the part that genuinely needs layers, so that is
  where the multiple tracks are.

## Licence

MIT
