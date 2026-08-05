# editor-cat

A small AI video editor that runs in your browser.

Write a prompt → get images → animate one into a clip → arrange clips on a
timeline → layer voiceovers and music → swap your voice for another one → export an MP4.

Every AI feature uses **your own API keys**. This app has no accounts, no
provider credentials, and no server-side storage of its own.

---

## What it does

| Step          | What happens                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Image** | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                                       |
| **2 · Video** | Pick a generated image as the opening frame and animate it. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame.                      |
| **Timeline**  | Drag clips to reorder, drag their edges to trim, set how long stills stay on screen. Audio sits on its own stacked tracks below.                                                                              |
| **3 · Audio** | Record as many voiceover takes as you like — they layer onto separate tracks automatically. Add music that sits under them. Convert any take into another voice with ElevenLabs; the original is always kept. |
| **Export**    | Render an MP4 in the browser with ffmpeg compiled to WebAssembly. Nothing is uploaded.                                                                                                                        |

## What you need

Two keys, both entered in **Settings** inside the app:

- **[fal.ai](https://fal.ai/dashboard/keys)** — images, video, and both prompt-improvement buttons. One key covers all three.
- **[ElevenLabs](https://elevenlabs.io)** — only for changing your recorded voice. Everything else works without it.

Keys are held in your browser. Tick _remember on this device_ and they go into
local storage; leave it off and they are gone when you close the tab. Either way
they are attached to each request as it passes through this site's proxy on the
way to the provider, and are never written to a server or a log.

**Costs are real.** Images are roughly $0.003–$0.04 each; video is roughly
$0.04–$0.40 per second of output depending on model. The app shows an estimate
before every generate button, because a mis-click on a video model is expensive.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:5173 — UI only, /api/* is unavailable
```

To exercise the real providers you need the Netlify functions running too:

```bash
npm install -g netlify-cli
netlify dev          # serves the app and /api/* together
```

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
2. Run `supabase/migrations/0001_projects.sql` — paste it into the dashboard's
   **SQL editor**, or `supabase db push` with the CLI. It creates two tables and
   turns on row-level security, so a user can only ever read and write rows on
   their own account.
3. **Authentication → Providers → Google → Enable**, and paste the _same_ Google
   client ID from the Drive setup above into **Authorized Client IDs**. No
   client secret is needed: the page hands Supabase a Google ID token directly
   rather than going through a redirect.
4. Copy the project URL and anon key from **Project settings → API** into `.env`
   (and into Netlify's environment variables), then redeploy.

The client ID must match in both places. If it does not, sign-in fails with
"Unacceptable audience" — the app rewrites that message to say so, because the
raw error points at nothing.

### Conflicts

Each project row carries a version. A write only lands if the version still
matches what this session last saw, so editing the same project in two tabs
shows "Changed elsewhere" rather than one tab silently overwriting the other.
Resolution is a reload — merging two timelines has no sensible automatic answer.

## Saving to your own Google Drive (optional)

Connect a Google account in **Settings** and pick a folder. From then on
everything the app makes — generated images, rendered clips, recordings, files
you upload — is copied into that folder as it is created, and **Library →
Import from Drive** browses that folder and its subfolders to bring existing
media in.

The bytes stay in IndexedDB either way; Drive is the durable copy, not the
playback source. Drive has no URL that carries our token _and_ serves range
requests, so a `<video>` pointed straight at it could not seek — and export
needs the bytes locally regardless. A failed upload therefore costs you the
backup and nothing else.

The app is fully usable without this. Leave `VITE_GOOGLE_CLIENT_ID` unset and
the Drive section of Settings just explains that it is switched off.

### Setting up the client ID

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen**. While it is in _Testing_ you can add
   up to 100 test users and nothing further is required.
3. Create an **OAuth client ID** of type _Web application_. Add your origins to
   **Authorised JavaScript origins**: `http://localhost:5173` for `npm run dev`,
   `http://localhost:8888` for `netlify dev`, plus your deployed URL. There is
   no redirect URI to set — the token flow never leaves the page.
4. Put the client ID in `.env` locally, and in Netlify under **Site settings →
   Environment variables** (it is read at build time, so redeploy after adding
   it):

```
VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

A client ID is not a secret — it ships in the bundle by design, and origin
allowlisting is what protects it.

### The two scopes, and the catch

- `drive.file` — the app's own files. Anything it uploads stays accessible to it
  forever, and it can see nothing else.
- `drive.readonly` — needed only to _list_ the folder you pick. Per-file access
  cannot enumerate media the app did not write, so without this the import
  browser would always come back empty.

**`drive.readonly` is a restricted scope.** In Testing mode that costs nothing.
But publishing the consent screen so that anyone can sign in requires Google's
annual third-party security assessment, which is expensive. If you intend to go
public and can live without importing pre-existing media, drop `drive.readonly`
from `DRIVE_SCOPE_LIST` in `src/lib/google/gis.ts`: uploads, the folder picker's
own listing of app-created content, and everything else keep working under
`drive.file` alone.

## Deploying to Netlify

The repo is deploy-ready; `netlify.toml` already declares the build command,
publish directory, functions directory, SPA fallback and security headers.

1. In Netlify, **Add new site → Import an existing project**.
2. Pick this repository. The build settings are detected from `netlify.toml`.
3. Deploy.

If you are using the Drive integration, set `VITE_GOOGLE_CLIENT_ID` in the
site's environment variables and add the deployed origin to the OAuth client's
authorised origins.

**No secrets are needed.** That falls out of the bring-your-own-key design: the
keys arrive from the browser on each request, so the deployment holds none of
its own. The one build-time variable, `VITE_GOOGLE_CLIENT_ID`, is optional and
is not a secret either.

Note that anyone who visits your deployed URL can use it with _their_ keys, and
the proxy will forward for any caller. If you would rather it not be public, add
Netlify password protection or access controls to the site.

## How it fits together

```
Browser (React + TypeScript + Tailwind)      Netlify Functions (stateless pass-through)
  Settings  — keys, in memory or local          /api/fal/*        → queue.fal.run
  Generate  — images, then image → video        /api/elevenlabs/* → api.elevenlabs.io
  Library   — blobs in IndexedDB                /api/media        → streams provider media
  Timeline  — one picture track + N audio tracks
  Projects  — timelines in Supabase (no media)  Both talk to the browser directly;
  Drive     — media in your own Drive           neither goes through our functions.
  Preview   — custom player over <video>        The caller's key is forwarded once and
  Export    — ffmpeg.wasm → MP4                 never stored, logged, or reused.
```

A few decisions worth knowing about:

**Why proxy at all, when the keys are yours?** Not secrecy — reliability.
Browser-direct calls depend on each provider's CORS policy, which changes
without notice. Going through our own origin makes it deterministic, and has a
second payoff: provider media arrives same-origin, so it never taints the canvas
during export.

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

**Drive tokens are never stored.** The browser token flow issues no refresh
token on purpose — a long-lived Google credential in a static site's local
storage has nothing protecting it. Tokens live in memory for about an hour and
are renewed silently; when Google will not renew without UI, Settings offers a
Reconnect button rather than throwing an error at whatever you were doing.

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
npm test          # unit tests — timeline maths, ffmpeg argv, SSRF guard, key storage
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
