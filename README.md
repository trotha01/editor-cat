# editor-cat

A small AI video editor that runs in your browser.

Write a prompt → get images → animate one into a clip → arrange clips on a
timeline → layer voiceovers and music → swap your voice for another one →
caption it karaoke-style → export an MP4.

Images and video are generated on the deployment's own fal.ai account, so
visitors need no key for them. Captions can be transcribed **in the browser for
free**, with no key at all. Voice conversion — and faster, more accurate
transcription — use **your own ElevenLabs key**, held in your browser.

---

## What it does

| Step             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Image**    | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **2 · Video**    | Pick a generated image as the opening frame and animate it with Seedance 2.0 at 480p. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame.                                                                                                                                                                                                                                                                                                                                                                                               |
| **Timeline**     | Drag clips to reorder, drag their edges to trim, set how long stills stay on screen. **Cut** (or `S`) splits the clip under the playhead in two; zoom in and every frame gets its own line to aim at. Clips that came with sound keep it, at a level you set per clip. Give the picture a **lead-in** to slide the whole track later and open black in front of it. A **clip sound** lane under the picture draws the waveform of whatever audio each video clip carries. Audio sits on its own stacked tracks below.                                                                                            |
| **Preview**      | Play the timeline back with the transport, or press **Fullscreen** (or `F`) to watch it filling the screen with the controls still to hand. `Space` plays and pauses, arrows nudge the playhead, `Esc` comes back.                                                                                                                                                                                                                                                                                                                                                                                               |
| **3 · Audio**    | Record as many voiceover takes as you like — they layer onto separate tracks automatically. Add music that sits under them. Drop in a **three-beep count-in** and drag it to the exact moment it should lead into. Convert any take into another voice with ElevenLabs; the original is always kept.                                                                                                                                                                                                                                                                                                             |
| **4 · Captions** | **Add captions** transcribes the speech on the timeline — with a speech model running in this tab for free, or with ElevenLabs if you have a key — and lays it out karaoke-style: one caption on screen at a time, with the word being spoken picked out. The transcript is editable — retype a misheard word and every other timing in the line is left alone. Captions get a lane of their own, where they can be retimed, trimmed, split and joined, and each word has a mark you can drag until the highlight lands on the voice. Large and bold by default; size, colour, weight and height are adjustable. |
| **Export**       | Render an MP4 in the browser with ffmpeg compiled to WebAssembly, captions burnt in. Nothing is uploaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## What you need

**As a visitor:** nothing. Image and video generation run on the site's own
fal.ai account, and captions can be transcribed in your own browser. A key buys
you voice conversion, and a better transcriber if you want one.

- **[ElevenLabs](https://elevenlabs.io)** — entered in **Settings**. Needed for changing your recorded voice; optional for captions, where it is the faster and more accurate of the two transcribers. Everything else works without it. It is held in your browser: tick _remember on this device_ and it goes into local storage, leave it off and it is gone when you close the tab. Either way it is attached to each request as it passes through this site's proxy, and is never written to a server or a log.

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
secret makes secrets scanning fail the build.

Then run `supabase/migrations/0002_google_connections.sql`, the same way as the
first migration. Setting the two secrets without running it gets you a site that
signs people in and then has nowhere to put the result.

If sign-in is refused, the screen says which of the three steps is unfinished —
missing secrets, unrun migration, or a store that simply did not answer — and
the function log for `/api/google/status` names the variable or prints the
database's own complaint.

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
Browser (React + TypeScript + Tailwind)          Netlify Functions (stateless pass-through)
  Settings  — one key, in memory or local          /api/fal/*        → queue.fal.run
  Generate  — images, then image → video             session verified, site's key attached
  Library   — blobs in IndexedDB                   /api/elevenlabs/* → api.elevenlabs.io
  Timeline  — picture + audio + caption lanes        the caller's own key, forwarded once
  Captions  — words with their own timings         /api/media        → streams provider media
  Speech    — Whisper in a worker, or Scribe       /api/google/*     → oauth2.googleapis.com
  Projects  — timelines in Supabase (no media)       holds the refresh token, mints
  Drive     — media in your own Drive                an access token per request
  Preview   — custom player over <video>
  Export    — ffmpeg.wasm → MP4, captions burnt in

                                                 Supabase and Drive themselves talk to the
                                                 browser directly, not through us — and the
                                                 in-browser speech model talks to nobody at
                                                 all once it has been downloaded.
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

**A cut is nothing but two clips.** Cutting splits the clip under the playhead
into two that carry on from each other, and that is the whole of it — no cut
list, no markers, no schema change. It saves and reloads because the timeline
does, and a project opened tomorrow shows its cuts because two clips meeting
mid-source _is_ a cut. The timeline recognises that and marks each one, with a
button to join the halves back together, which is as close as this editor gets
to an undo. Cuts snap to a frame, and the frame lines drawn once you are zoomed
in far enough are the same grid — so the line you park the playhead on is the
line the cut lands on. The arithmetic is in `src/lib/timeline.ts` with the rest
of the pure timeline maths.

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

**Two transcribers, one interface.** Captions can be written by ElevenLabs
Scribe or by Whisper running in the tab, and they differ in more than a network
call — which is why `src/lib/transcribeEngines.ts` makes them an interface rather
than a flag. Scribe is accurate and fast, needs a key, and has to stay under a
serverless payload ceiling, so it slices the audio up and posts it. The browser
model is free, needs no key, and never sends your voice anywhere, but downloads
about 80MB once and then thinks for roughly the length of the audio again — so it
takes the whole stretch and reports progress instead. What they share is the
currency: mono 16kHz samples in, words timed from the start of the source file
out. Both hear exactly the same audio, so switching engines changes the accuracy
of the transcript and nothing about how it lands on the timeline. With a key the
paid one is the default; with none, the free one is not a consolation prize but
the only one that can run — and it can.

**The speech runtime is self-hosted and loaded on demand.** transformers.js and
the ONNX Runtime it executes the model with both come from our own origin
(`scripts/copy-speech-runtime.mjs`), for the same reasons as the ffmpeg core: the
Content-Security-Policy only allows scripts from 'self', and a CDN outage should
not break a feature. They are fetched at the moment they are first needed rather
than bundled, so a visitor who never captions in the browser downloads none of
it. Bundling was tried and is worse than it sounds — transformers.js picks its
ONNX build at runtime, per browser, and asking a bundler to guess got a 23MB
WebAssembly file inlined into the output that nothing would ever load. Handing
over the whole directory leaves the choice where it belongs. The model weights
themselves come from Hugging Face on first use and are cached by the browser.

**Whisper needs cleaning up after.** It was trained on subtitled video, so given
silence or music it reaches for what subtitles say when nobody is speaking —
"Thanks for watching", "Subtitles by…" — with confident timings, and it falls
into loops that emit one word thirty times. It also leaves a space on the front
of every word, and sometimes never closes the last one. All of that is handled in
`src/lib/whisperWords.ts`, which is deliberately free of any import from the
runtime so the fiddly part can be tested without a 12MB engine and an 80MB model.

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
file: Inter, copied out of node_modules at build time by
`scripts/copy-caption-font.mjs`, served from this origin, and handed to ffmpeg in
its own virtual directory. The preview loads the same two files through
`@font-face`, which is the point — what you position over the picture is drawn
with the very bytes that end up in the MP4.

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
                  # the karaoke subtitle file, Whisper's output quirks, ffmpeg
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
  downloads about 80MB the first time, runs on your CPU at roughly the length of
  the audio again, and mishears more — particularly accents, crosstalk and noise.
  The transcript is editable precisely because no transcriber is right every
  time. It also needs to reach huggingface.co once to fetch the model; after that
  it works offline, and it never sends your audio anywhere at all.
- **The in-browser model is single-threaded and CPU-only.** Threads would need
  cross-origin isolation, which would block loading provider media in the page,
  and WebGPU would be a second execution path reachable on only some machines.
  Both are the same trade the exporter already makes.
- **Redoing captions replaces them.** Transcribing again is how you redo a bad
  take, so it discards whatever was edited by hand on that track rather than
  trying to merge two transcripts.
- **Export uses the single-threaded ffmpeg build**, so a short project takes
  roughly 30–90 seconds. The multithreaded build needs cross-origin isolation
  (COOP/COEP), which would block loading provider media in the page.
- **One picture track, and no transitions.** This is deliberate — visual clips
  sit end to end with no gaps, which removes most of what makes a timeline
  confusing. Audio is the part that genuinely needs layers, so that is where the
  multiple tracks are. The only text over the picture is captions, which are not
  free-placed titles: they are the words that were spoken, laid out by one style
  per track.
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
