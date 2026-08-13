# editor-cat

A small AI video editor that runs in your browser.

Brainstorm a scene idea → write a prompt → get images → animate one into a clip
→ arrange clips on a timeline → dissolve between them → layer voiceovers and
music → swap your voice for another one → caption it karaoke-style → export an
MP4.

Images, video and caption transcription run on the deployment's own fal.ai
account, idea generation calls the Claude API directly on its own Anthropic
account, and the voice features run on its own ElevenLabs one — so visitors
need **no key at all**. Signing in is the whole of the way in.

---

## What it does

| Step             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Idea**     | Type a single word and get 20 tiny, weird scene ideas back from Claude — one or two characters (not necessarily human), an absurd situation, and a line of dialogue that uses the word, all sized to the 8-10 seconds a clip actually gets. Ask for a different number (1-50), and edit the **prompt sent to Claude** right on the tab if that shape of scene isn't the one you're after — **Reset prompt** puts the stock brief back. **Copy** any of them into the Image prompt to get started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **2 · Image**    | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **3 · Video**    | Pick a generated image as the opening frame and animate it with Seedance 2.0 at 480p. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Timeline**     | A clip added from the **Library** lands after the clip the playhead is on, so the next shot arrives where you are working rather than at the end of the track. Drag clips to reorder, drag their edges to trim, set how long stills stay on screen. Every clip carries a **⋯ menu** with what can be done to that clip alone — caption it, [say its captions again properly](#fixing-a-clip-that-says-it-wrong), silence it, take it off the timeline. **Cut** (or `S`) splits the clip under the playhead in two; zoom in and every frame gets its own line to aim at. The mark between two clips opens a **transitions** picker — cross dissolve, dips, wipes, slides, blur and an iris — with a duration you can drag and an **Apply to all**. Clips that came with sound keep it, at a level you set per clip. Give the picture a **lead-in** to slide the whole track later and open black in front of it. A **clip sound** lane under the picture draws the waveform of whatever audio each video clip carries. Audio sits on its own stacked tracks below. **Start**/**End** (or `I`/`O`) mark where an export of the timeline begins and ends at the playhead, drawn as a band across every lane with a handle on each edge to drag — the same range the export dialog opens onto, and either side stays in step with the other. |
| **Preview**      | Play the timeline back with the transport, or press **Fullscreen** (or `F`) to watch it filling the screen with the controls still to hand. `Space` plays and pauses, arrows nudge the playhead, `Esc` comes back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **4 · Captions** | **Add captions** transcribes the speech on the timeline with ElevenLabs Scribe, and lays it out karaoke-style: one caption on screen at a time, with the word being spoken picked out. The transcript is editable — retype a misheard word and every other timing in the line is left alone. Any single clip can be captioned or redone from its own **⋯ menu on the timeline**, which replaces only that clip's captions and leaves every correction made elsewhere standing. Captions get a lane of their own, where they can be retimed, trimmed, split and joined, and each word has a mark you can drag until the highlight lands on the voice. Large and bold by default; size, colour, weight and height are adjustable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **5 · Audio**    | Record as many voiceover takes as you like — they layer onto separate tracks automatically. Add music that sits under them. Drop in a **three-beep count-in** and drag it to the exact moment it should lead into. Convert any take into another voice with ElevenLabs; the original is always kept. A clip whose own dialogue is mispronounced is fixed from the timeline instead — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Export**       | Render an MP4 in the browser with ffmpeg compiled to WebAssembly, captions burnt in. The whole timeline by default, or a **start and end** — marked on the timeline itself, or typed here — to cut a piece out of it. Download it, or publish it straight into [Mintspace](#publishing-to-mintspace-optional) — a vertical video feed — without leaving the dialog. The render happens here either way; only the finished file ever goes anywhere. What a project has published is remembered, so the same video cannot go up twice, and anything already up can be deleted from the same dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Words**        | A second page, reached from **Words** in the header (`#/words`), for building up a shelf of words rather than cutting one project. Three navigation columns on the left — a tier ("1st tier", "Classical", "ESL"), then a language taught in it, then a word of that language — with **Add** under each. Upload the videos for the selected word, label each one **Intro**, **Word** or **Outro**, drag them (or use the ↑↓ on each row) into the order they should play, and type the transcript of what is said in it. **Watch together** plays the whole run back to back in one player, moving to the next take on its own and showing each one's transcript as it goes. The shelf **is a tree of folders in your Drive** — one per tier, one per language inside it, one per word inside that, and that word's videos in the word folder — so it opens the same on your next machine, a video dropped into a word's folder from your phone turns up in the app, and **Open the Drive folder** on any word takes you straight to it. See [The word shelf in your Drive](#the-word-shelf-in-your-drive).                                                                                                                                                                                                                              |
| **Report**       | A bubble in the bottom-right corner files a bug report, a feature request or a question as an issue on the project's tracker — no GitHub account needed. What it will publish, the reporter's email address included, is shown before anything is posted. See [Reporting bugs from inside the app](#reporting-bugs-from-inside-the-app).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## What you need

**As a visitor:** a Google account, and nothing else. There is no key field
anywhere in the app: every provider call — ideas, images, video, captions,
changing a recorded voice, and [fixing a clip that pronounces its line
wrong](#fixing-a-clip-that-says-it-wrong) — runs on the site's own accounts.

**As whoever deploys it:** a [fal.ai](https://fal.ai/dashboard/keys) key as
`FAL_KEY`, an [Anthropic](https://console.anthropic.com/settings/keys) key as
`ANTHROPIC_API_KEY`, and an [ElevenLabs](https://elevenlabs.io) key as
`ELEVENLABS_API_KEY`, all in the site environment. Everyone who can sign in
can spend all three, so if this is not meant to be open to anyone with a
Google account, narrow that in Auth0 rather than here. See
[Deploying to Netlify](#deploying-to-netlify).

**Costs are real, and they land on the deployment.** Images are roughly
$0.003–$0.04 each; video is roughly $0.04 per second at 480p on the default
model, rising to $0.40 on the most expensive one in the picker. Captions are
$0.008 per minute of audio transcribed. Fixing a clip's audio is billed by the
character — around $0.10 per 1,000, so about 2 cents for a ten-second line — and
the dialog counts the characters before the press. The app shows an estimate before every
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

## Fixing a clip that says it wrong

Ask a video model for a line in two languages and it will usually give you one:
the English half lands, and the Spanish or Italian half comes out with an
English mouth — the stress on the wrong syllable, vowels from the wrong
alphabet, sometimes a word that does not exist. The picture is fine. Only the
sound is wrong, and it is wrong in the one way nothing downstream can repair:
the voice changer keeps the delivery it is given, which is exactly the part that
needs replacing, and generating the shot again rolls the dice on everything else
in it.

So the line is said again — and **the captions are the script**.

**Caption the clip first** (the item directly above in the same ⋯ menu), then
**⋯ menu on the clip → Fix this clip's audio**. The dialog holds this clip's
captions, one row each with the moment the picture says it:

1. **Correct the lines.** These are the real captions, not a copy: pressing the
   button saves your edits to them and then says them, so the subtitle and the
   voice cannot drift apart. Spell a word the way it should be pronounced and
   both follow.
2. **Language** stays on _detect from the text_ by default, which is the right
   answer for the clips this exists for: a line that says it in English and then
   again in Italian is two languages in one breath, and naming either one makes
   the model read the other with the wrong mouth. Name a language when the whole
   line is in it and you want it enforced.
3. **Voice** defaults to _copy this clip's own voice_. ElevenLabs is handed up to
   30 seconds of the clip's own audio, copies the voice from it, says your lines
   in that copy, and the copy is deleted again on the way out. Pick a ready-made
   voice instead if you would rather, or if the account's plan does not include
   cloning.

None of this asks the visitor for anything: it runs on the key the deployment
sets as `ELEVENLABS_API_KEY`, the same arrangement image and video generation
already have with fal. There is no key field in the app at all.

### Why a line at a time

Each caption is spoken as its own request and laid **on that caption's mark**, so
the new speech tracks the performance it is standing in for rather than starting
right and drifting away over the length of the clip. The lines either side go
along as context — not spoken, not billed — which is what keeps a passage
sounding like one person talking instead of a list of sentences.

A reading is very often quicker than the performance was, and a line will **come
forward into the room the one before it left unused** rather than wait out a
pause the speaker never took — mid-sentence that silence does not sound like
timing, it sounds like the audio dropping out. A line can be at most one
predecessor's shortfall early, however many quick readings came before it, so
this closes gaps without letting a long clip walk away from its picture.

Then the timings come back the other way. ElevenLabs reports when it said every
word, and **the captions are re-timed to that**, so the karaoke highlight lands
on the syllable actually being spoken. Nothing can make a model say a word at a
chosen moment — there is no such parameter, and stretching the audio would sound
like stretched audio — but a caption is free to move, and moving it is exact.

What comes back is laid on a **voice track under the clip** and the clip's own
sound is **muted**. The audio is anchored to the clip, so it follows that shot
around the timeline like a voiceover recorded against it, and it is mixed into
the preview and burnt into the export like any other audio. One undo takes the
audio, the mute and the new timings back together; your caption edits are a step
of their own, so a second undo is what returns the words.

Fixing the same clip again **never overwrites** what is already there. The new
reading lands on a row of its own and the row before it is muted, so only the
newest plays — but every take you have paid for is still on the timeline, one per
lane, and un-muting a lane is one click if the earlier reading was better.

A clip with **no captions** still works: one text box, one piece of audio at the
head of the clip, and none of the line-by-line timing above. The dialog says so.

Nothing stretches speech to fit a shot, so a line that takes longer to say than
its caption had room for pushes the line after it later rather than talking over
it. The result says how many that happened to, which is the cue to shorten the
text or give those captions more room.

## Reporting bugs from inside the app

There is a **💬 bubble in the bottom-right corner** of the editor. It opens a
short form — what kind of thing this is, a title, the details — and files it as
an issue on the project's tracker. No GitHub account is needed at either end:
the token belongs to the deployment, which is the point, because most people who
hit a bug have no intention of getting an account to tell you about it.

**Everything the issue will carry is on the form before anything is posted**,
behind a **What gets attached** disclosure:

- **The reporter's email address**, from their Google sign-in. It is read from
  the verified session by the function, never from the request body, so nobody
  can file under somebody else's name. The form shows the exact address the
  server will attach, which is why it asks the server rather than assuming.
- The build SHA, branch and deploy context, the page origin, the user agent, and
  the window and screen size.
- The shape of the open project: how many clips, how long, how many audio clips
  and captions, which way up.

Note that the tracker is public, so the address is published with the report.
That is deliberate — it is how anyone answers a reporter who is not watching the
thread — but it does mean an address that scrapers can find. If that trade is
wrong for your deployment, the address is attached in one place
(`reporterLine` in `netlify/lib/github.ts`).

### Letting a deployment file issues

Two environment variables, both server-side:

- **`GITHUB_TOKEN`** — a **fine-grained personal access token** scoped to the one
  repository, with **Issues: read and write** and nothing else. That is the whole
  permission it needs: so scoped, a leak cannot read code, push, or touch another
  repository. No `VITE_` prefix, or it would be inlined into the browser bundle
  and published.
- **`GITHUB_REPO`** — `owner/repo`, the tracker reports go to.

Without both, `/api/github/status` answers `configured: false` and the bubble
says reporting is not set up here rather than taking a report to nowhere.

**For the address to be an address**, the Auth0 tenant has to put one in its
_access_ tokens — a Login Action adding the namespaced claim
`https://editor-cat/email`, alongside the `role: authenticated` one Supabase
already needs. Auth0 silently drops un-namespaced custom claims from an access
token, which is why the claim looks like a URL. Without it the report still says
who filed it, but as the Auth0 account id, which you can look up in the
dashboard.

Filing is deliberately narrow, because it writes to a public place under the
deployment's own account:

- **Signed in only.** `/api/github/issues` verifies the caller's Auth0 token, the
  same check `/api/fal/*` makes.
- **Five reports per account per ten minutes**, best-effort: functions scale out,
  so the counter is per instance. It exists to stop a stuck retry loop, not to
  stand in for the session check.
- **Titles and bodies are capped** server-side, and truncated rather than
  refused — losing five minutes of somebody's writing to a limit nobody showed
  them is worse than filing a report that says it was cut short.
- **`@mentions` and `#123` references are neutralised** with a zero-width space,
  so a report cannot be used to notify a stranger or cross-link an unrelated
  issue. The collected details go in a fenced block, which renders nothing — the
  address included, so GitHub does not turn it into a `mailto:` link.
- Issues arrive labelled `from-app` alongside `bug`, `enhancement` or `question`.

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

**The project name in the header is the switcher.** Clicking it opens the list
of your projects, with a new one and a delete beside each. It is not a text
field: switching is what anyone clicking a title in a header is after, and the
name is renamed in **Settings → Project name**, which the menu itself points at.
Signed out, or with no Supabase project configured, there is one project and
nothing to switch between, so the name is plain text there and Settings is still
where it is renamed.

**Getting in is three steps, and each asks for one thing.** Sign in with Google;
grant permission to write to your Drive; pick the folder your media goes into.
Then the editor. The second step is asked with the first one's email as a hint,
so Google does not make you choose an account twice. Settings keeps the folder
and the sign-out, and nothing else about Google.

**Three steps once, one step after that.** Both answers are kept against the
account rather than in the browser that gave them — the Drive grant by Auth0's
Token Vault, the folder by a table of this app's own — so every later sign-in is
a single click, on a new machine as much as on the same one. The folder used to
live in localStorage alone, which signing out clears (it is an id in one
account's Drive, and the next person at that keyboard must not inherit it), so
every login was asked where its media should go all over again.

It was briefly two, because Auth0 will carry a Drive scope through its login and
the consent screen duly shows the folder next to the account. That grant lands
against the user's _identity_, and Token Vault — which is what the functions
exchange against — reads `connected_accounts`, a store only Auth0's own connect
flow fills. So the folder is asked for after the sign-in rather than during it:
not a screen that could have been saved, but the only ask that stocks the vault.
See [what sign-in needs](#what-sign-in-needs).

**What lives where.** Supabase holds the timeline — clips, tracks, trims, audio
placement, resolution, and the captions with every word timing in them — plus a
catalogue of asset metadata and the Drive folder each account writes into. It
never holds media bytes. Those are in your Google Drive, and cached in each browser's IndexedDB.
Opening a project on a new machine restores the timeline from metadata
immediately, so you can rearrange it while the media is still coming down from
Drive behind you.

**Media that predates Drive cannot be recovered on another machine.** An asset
with no `driveFileId` only ever existed in the browser that made it; those clips
open with their timing intact and report as unrecoverable.

**Deleting a project asks first, and keeps it for 90 days.** The confirmation
names the project — the button is a small icon in a list of near-identical rows —
and what follows is a `deleted_at` stamp rather than a `delete`. It leaves the
project menu, reappears at the bottom of it under **Recently deleted** with the
days it has left, and one click puts it back. After 90 days it is destroyed for
real. Your Drive is not touched either way: deleting a project deletes an
arrangement of media, never the media.

The purge runs when a session starts, which is the only scheduler this app has,
so it sweeps an account the next time its owner signs in rather than the day a
project expires. The 90 days are a promise about the earliest something can stop
being restorable, not the latest it can survive — there is a `pg_cron` version in
`supabase/migrations/0008_project_archive.sql` for a deployment that wants both.

Leave `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` unset and the app behaves
exactly as it did before: one project, IndexedDB, no sign-in.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com).
2. Run the files in `supabase/migrations/` in order — paste them into the
   dashboard's **SQL editor**, or `supabase db push` with the CLI. `0001` creates
   the projects and assets tables with row-level security, so a user can only
   ever read and write rows on their own account. `0002` adds the table that
   held Google refresh tokens, and `0004` drops it again, now that Auth0's Token
   Vault holds them instead. `0003` drops the foreign keys that pointed at
   `auth.users`, which an external account has no row in; without it every insert
   fails on a constraint. `0006` changes `user_id` from `uuid` to `text` and
   moves the policies onto `auth.jwt() ->> 'sub'`, because Auth0 subjects are not
   UUIDs — see [migrating an existing project](#migrating-an-existing-project).
   `0007` adds the one-row-per-user table holding the Drive folder each account
   writes into, so a sign-in restores it instead of asking for it again. `0008`
   makes deleting a project reversible: a `deleted_at` column, plus the two
   functions that stamp it and sweep up after 90 days.
3. **Supabase Auth is not used at all** — there is no provider to enable there.
   What Supabase needs instead is Auth0 registered as a third-party auth
   provider, and one Auth0 Action. Both are dashboard work, neither can be done
   from this repository, and nothing saves until they are: see
   [what sign-in needs](#what-sign-in-needs).
4. Copy the project URL and anon key from **Project settings → API** into `.env`
   (and into Netlify's environment variables), then redeploy.

Row-level security is still what protects the data. What changed under it is
whose token PostgREST is reading: the browser now hands over the Auth0 ID token
unaltered, PostgREST validates it against the tenant's published keys, and the
policies compare `auth.jwt() ->> 'sub'` against the row. Nothing in this
repository signs anything any more.

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

### When the project list does not load

Said out loud, in two places, because this failure is otherwise invisible. When
the list cannot be fetched nothing gets opened, so the editor comes up on a
blank document that is indistinguishable from a new project, and the switcher
opens onto an empty menu that is indistinguishable from a new account. A banner
under the header names the error and says the plain consequence — nothing
changed in that blank project is reaching your account — and the switcher menu
repeats it for anyone who went looking for their projects first. Both offer a
retry, which fetches the list again and opens a project without disturbing
whatever is already on screen.

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

   Confirm the client id and secret actually saved. Token Vault refuses to
   store anything against Auth0's shared development keys, and a connection
   that has quietly fallen back to them fails much later and somewhere else, as
   `federated_connection_refresh_token_not_found` — a sentence about refresh
   tokens, three steps downstream, naming a different client. The tell is on
   Google's own consent screen: **"auth0.com wants access to your Google
   Account"** means the dev keys, and your own application's name means your own
   keys. The tenant log says it outright too, as a warning during login.

5. Create an **API** in Auth0 — its identifier is `VITE_AUTH0_AUDIENCE`, and any
   URI will do so long as it matches everywhere.
6. Create a **Single Page Application** for the browser. Its client id is
   `VITE_AUTH0_CLIENT_ID`; its Allowed Callback URLs, Allowed Logout URLs and
   Allowed Web Origins cover wherever the app is served from, and its
   Connections tab has `google-oauth2` enabled.

   Enable **Refresh Token Rotation** on it. Auth0 refuses to issue a
   _non-rotating_ refresh token to a browser at all — a long-lived one sitting
   in a page is the thing rotation exists to avoid — and `useRefreshTokens` in
   src/lib/auth0/client.ts expects one. A Single Page Application has rotation
   on by default, which is most of why the type matters: a Regular Web
   Application with its authentication method set to None looks identical from
   the browser, does PKCE, signs in, and defaults to non-rotating.

   Nothing surfaces at the time. The session appears to work, stops surviving
   reloads once the access token expires, and Token Vault holds no Google tokens
   because none were ever stored — which appears hours later, somewhere else,
   against a different client id, as `tokenset_not_found`. Only the tenant log
   under Monitoring → Logs connects the three, and only if you think to look:
   "no 'refresh_token' was issued because the authorization code exchange
   originated from a browser"

7. Turn on the half of Token Vault that a login does not fill. Three things have
   to be true before the browser's connect flow can run, and only the first has
   a dashboard:

   - **Activate the My Account API** (Dashboard → Applications → APIs). Its
     identifier is `https://YOUR_TENANT.us.auth0.com/me/`, trailing slash and
     all.
   - Give the SPA a **user-delegated** grant on it, from that API's Application
     Access tab, with the `*:me:connected_accounts` permissions.
   - Add an **MRRT policy** to the SPA naming that same audience, so one refresh
     token reaches both this app's API and Auth0's.

   The last two have no dashboard between them and no error when they are
   missing: a policy naming an API that is not activated is silently ignored,
   and a client grant created over the Management API with `subject_type: user`
   can come back stored as `client` — accepted, inert, and sitting right there
   while the browser is refused for want of it.
   `scripts/auth0-connect-setup.mjs` does the last two and reads back what it
   wrote; `scripts/auth0-tokenvault-doctor.mjs` reads the objects rather than
   the pages when they disagree.

8. On that API's page, press **Add Application**, name it, and press **Add** —
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

9. Create a Google **API key** under the same Cloud credentials page, restricted
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
address from its own ID token — but without it `netlify/lib/auth0.ts` sees an
empty `email` for the caller, which is only ever read for logging. Namespaced
because Auth0 drops unnamespaced custom claims from access tokens; the `role`
claim Supabase needs is subject to the same rule, which is why it goes on the ID
token instead. See [what sign-in needs](#what-sign-in-needs).

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

Beyond the Auth0 setup above, **four steps that can only be done by hand**, in
two dashboards. None of them is in this repository, and the deploy does not work
without any of them. Do them before you deploy, or a sign-in succeeds and every
query afterwards comes back empty.

**1. Register Auth0 on the Supabase project.** Supabase dashboard →
**Authentication → Third-Party Auth → Add integration → Auth0**, and give it your
tenant ID (and region, where the dashboard asks for one). That is what tells
PostgREST to fetch `https://<tenant>/.well-known/jwks.json` and accept tokens it
can verify against those keys. With the CLI it is the same thing in
`supabase/config.toml`:

```toml
[auth.third_party.auth0]
enabled = true
tenant = "<id>"
tenant_region = "<region>"   # where applicable
```

**2. Add an Auth0 Login Action setting the role claim.** Auth0 → **Actions →
Triggers → post-login**, a new action containing exactly this:

```js
exports.onExecutePostLogin = async (event, api) => {
  api.idToken.setCustomClaim('role', 'authenticated')
}
```

Then drag it into the Login flow and deploy it. PostgREST switches to the
Postgres role named in the token's `role` claim, and `authenticated` is the role
the policies are written against; without the claim it reads the tables as `anon`
instead.

> **`idToken`, not `accessToken` — and this is the reason the browser sends
> Supabase the ID token.** Supabase's Auth0 guide is explicit: "Auth0 silently
> strips non-namespaced custom claims from access tokens, so
> `api.accessToken.setCustomClaim('role', 'authenticated')` does not work. Use
> `api.idToken.setCustomClaim` and pass the ID token to Supabase." A namespaced
> claim would survive the access token, but `https://example.com/role` is not the
> claim PostgREST reads. So the ID token is the only one of Auth0's two tokens
> that can carry it, and `src/lib/auth0/client.ts` has one accessor for each:
> `auth0IdToken()` for Supabase, `auth0Token()` for this site's own functions.
> Checked against Supabase's documentation on 2026-08-10.

> **Two tokens means two clocks, and auth0-spa-js only watches one of them.** If
> the site works after a sign-in and then answers `PGRST303` — `"JWT expired"` —
> on every query some hours later, with the session otherwise intact, this is
> it. `getTokenSilently()` renews on the _access_ token's expiry: the SDK
> stores a cache entry as `now + expires_in` from the token response and never
> reads the ID token's own `exp`, and the ID token it returns sits in a separate
> per-client cache entry that carries no expiry at all. Auth0's defaults are ten
> hours on an ID token (Applications → your app → Settings → **ID Token
> Expiration**) and twenty-four on an API access token (APIs → your API →
> **Token Expiration**), so for the fourteen hours in between the SDK sees a
> current cache, refreshes nothing, and hands PostgREST a token that died hours
> ago. `auth0IdToken()` checks `exp` on the token it is about to send and renews
> a stale one with `cacheMode: 'off'`, which is the only way to make the SDK
> spend the refresh token when its own bookkeeping sees nothing wrong. Setting
> the ID token's lifetime to match the API's would close the window too, but it
> is a dashboard setting rather than a property of the deployment, so the code
> does not rely on it.

**3. Make sure the access token's `aud` includes `VITE_AUTH0_AUDIENCE`.** This is
the API identifier from Auth0 → **Applications → APIs**, and the SPA already asks
for it — `authorizationParams.audience` in `src/lib/auth0/client.ts`. It is what
`/api/fal/*` checks before attaching the fal key, so a token minted for some
other API of the same tenant is refused even though the signature is good. If the
audience is wrong or absent, sign-in works, saving works, and generation answers 401.

**4. Remove `SUPABASE_JWT_SECRET` from the Netlify environment.** Nothing reads
it. It is a credential that can mint a session as anybody, and leaving it set
keeps that risk for no benefit.

One secret is still needed, **scoped to Functions** — read at request time, not
at build time. Marking a `VITE_` variable secret makes secrets scanning fail the
build, so mark only this one:

```
AUTH0_BACKEND_CLIENT_SECRET=     # the API's Custom API Client
```

#### Migrating an existing project

Run the files in `supabase/migrations/` in order, but check which have actually
been applied first — this project's history is not a clean run. On the live
project (`dxfxvvrbltjckstlnhup`) only `0005_project_drive_folder.sql` has been
applied; **`0003`, `0004`, `0006`, `0007` and `0008` are outstanding**. All five
need running, and the order between them does not matter: `0004` only drops a
table, `0007` only creates one, `0008` adds a column and two functions to a table
whose type change it does not depend on, and `0006` repeats `0003`'s two
`drop constraint if exists` statements rather than assuming `0003` has run — it
has to, because `alter column ... type` rebuilds any foreign key on the column,
and a text column referencing `auth.users (id)` cannot be rebuilt at all.

`0006_auth0_subject_ids.sql` is numbered around `0005` deliberately: `0005`
belongs to an open pull request that adds a `drive_folder_id` column and was
applied to the live project ahead of merging. Numbering the two independently
means neither branch has to be renumbered whichever lands first. There is no
missing `0005` in this branch.

**`0006` makes existing rows unreachable.** `auth.uid()` is
`(request.jwt.claims ->> 'sub')::uuid`, and Auth0 subjects — `google-oauth2|104372…`
— are not UUIDs, so the columns become `text` and the policies compare
`auth.jwt() ->> 'sub'` instead. Rows written under the old UUID user ids are not
deleted; they simply stop matching any policy, and the account they belonged to
sees an empty project list. If you have data worth keeping, build the mapping
from old `user_id` to Auth0 `sub` **before** running it — the file itself carries
the `update` statements and the warning about ids that map to two accounts.

**Why no signing secret any more.** Supabase used to reject Auth0's tokens
outright, so `/api/session` verified one and signed a Supabase-shaped replacement
with the project's own key. That whole endpoint is gone. Registering Auth0 as a
third-party provider is the supported version of what the mint was imitating, and
it removes both a credential and a hop.

**No round trip to verify.** Auth0 signs with RS256 and publishes the public
half, so `netlify/lib/auth0.ts` checks a token without leaving the process —
signature, issuer, audience and expiry, with the signing keys cached for an hour
and refetched once on an unrecognised key id. That is what lets `/api/fal/*`
verify every status poll of a minutes-long video job without calling the tenant
each time.

**Where the Drive token comes from.** Auth0's Token Vault holds the Google
tokens. `/api/google/token` exchanges the caller's Auth0 token for a Google one
(`netlify/lib/tokenVault.ts`), so Google's refresh token never reaches this
codebase — there is none here to leak, and no table to back up or lose.

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

## Publishing to Mintspace (optional)

[Mintspace](https://github.com/trotha01/mintspace) is a vertical video feed —
open the site, a video plays, scroll for the next one. With one configured, the
export dialog offers it as a destination alongside the download: pick **Publish
to Mintspace**, write a caption, and the export goes into the feed.

The render is unchanged and still runs in this tab. Your source media — the
generations, the recordings, the takes you did not use — never leaves the
machine. What is uploaded is the finished MP4, and only that, to a bucket anyone
can read, because that is what being in a feed means.

### Two accounts, and why

**Signing in to Mintspace is a separate act from signing in here.** This app's
identity is Auth0; Mintspace's row level security is built on Supabase Auth,
where `auth.uid()` casts the token's subject to a uuid — and an Auth0 subject
(`google-oauth2|104372…`) does not survive that cast. So the export dialog asks
for a Mintspace account of its own, and remembers it. It can make you one
without leaving the page.

Everything is written straight from the browser under Mintspace's own rules:
uploads land in `mintspace-videos/<your-uid>/…`, the row carries
`user_id = auth.uid()`, and anything else is refused by their database rather
than by us. There is no endpoint here, no service key, and nothing server-side
to configure — which also means a deployment cannot post as anybody.

### Setting it up

Point the site at Mintspace's Supabase project:

```
VITE_MINTSPACE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_MINTSPACE_SUPABASE_ANON_KEY=eyJhbGciOi...
VITE_MINTSPACE_URL=https://your-mintspace-site   # optional, for the "open it" link
```

Leave the first two unset and the export dialog never mentions Mintspace; it
only downloads.

That project may be the **same one** this app saves projects to, or a different
one. Mintspace namespaces everything it owns — tables under a `mintspace`
Postgres schema, storage under a bucket of the same name — so sharing a project
is supported by design, and the two sign-ins stay independent either way (the
Mintspace session gets a storage key of its own, so neither can clobber the
other).

On the Mintspace side it needs its `supabase/schema.sql` run, and `mintspace`
added under **Project Settings → API → Exposed schemas**. Both are steps in its
own README; getting either wrong is reported here as the specific thing that is
missing rather than as a failed upload.

### What is already up, and taking it down

The dialog lists every video this project is live as in the feed, with what it
was captioned, when it went up and whose account it belongs to. Each one has a
**Delete** beside it, which takes the row out of the feed and the file out of the
bucket — asked about first, because it cannot be undone and anyone holding the
link loses it. Your project and its media are untouched either way.

That list is one block that reads three ways, and never two at once. Straight
after a publish it is **Published**, because that is news. Reopen the dialog and
the same fact is a record: **Already in the feed**, or **Already in the Mintspace
feed** when the export you are about to make is the one that is up. The rows are
the same in all three, so deleting is always to hand. Once a project has
anything in the feed the button reads **Render and republish to Mintspace**,
since that is what any further publish would be.

**The same video cannot go up twice**, and you are told before you press
anything. Opening the panel fingerprints the timeline and the export settings
and compares that against what this project has already posted: if it matches,
the block above says so and the publish button is off. Edit the project, change
the size or quality, or delete the post that is up, and it comes back on.

That check is a prediction — it says the export would be made from the same
things, not that the bytes will match — so the finished file is hashed as well,
just before it is uploaded, and a duplicate is refused there too. Two
fingerprints because they answer at different moments: one is knowable without
rendering, the other is exact. The second catches what the first cannot, such as
editing a caption on a hidden track, which changes the timeline but not one
frame of the picture.

That record lives on the project document, not in this browser, so it syncs with
everything else: publish on a laptop and the phone knows about it too. It is
deliberately kept out of the undo history — Ctrl+Z reaches back through your
edits, not into a feed, and an undo that forgot a live video would be an undo
that let it be posted again.

Deleting is the one thing here that needs the _same_ Mintspace account that
published it. A different account is refused by Mintspace itself, and quietly:
row-level security answers a delete it will not allow with zero rows rather than
an error, so the account is checked before anything is asked, and a video
someone else published says so rather than appearing to vanish.

### Worth knowing

- **Mintspace plays vertical.** A 16:9 project publishes fine but sits in a
  letterbox, so the dialog says so before you spend the render. The Orientation
  toggle above the preview is what changes it.
- **The bucket caps uploads at 100 MB** by default. A long project at 1080p can
  pass that; the failure says so and suggests the setting to change.
- **Rendering once covers both.** Download an export to check it and then
  publish it, and the file that goes up is the one you checked — not a second
  render at the same settings. Change the resolution, the quality or the start
  and end and it is encoded again, because then it genuinely is a different file.
- **The destination and quality are remembered**, in this browser, so a second
  video exports the way the first one did. The frame size is not among them: it
  belongs to the project, where it also drives the preview and the orientation
  toggle, so each project keeps its own. Neither is the start and end: that
  describes one timeline rather than a preference, so it goes back to the whole
  video whenever the timeline's length changes.
- **No thumbnail is uploaded.** The row's `poster_url` is left unset, and
  Mintspace shows the video's own first decoded frame instead.
- **A video deleted in Mintspace itself** is noticed the next time you delete it
  from here: the row has already gone, nothing fails, and the editor stops
  listing it.

The code is `src/lib/mintspace/` (the client, the publish and delete flows, and
what a project has already posted) and `src/components/MintspacePublish.tsx`
(the panel in the export dialog).

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

### The secrets this needs

Set **`FAL_KEY`**, **`ANTHROPIC_API_KEY`** and **`ELEVENLABS_API_KEY`** in the
site's environment variables, for **all deploy contexts** — scoped to
production only, every deploy preview answers 503. None takes a `VITE_`
prefix: that would inline it into the browser bundle and publish it.

The first pays for images, video and captions; the second for the Idea tab,
which calls the Claude API directly; the third for the voice features —
changing a recorded voice, and [fixing a clip that says its line
wrong](#fixing-a-clip-that-says-it-wrong). Only `FAL_KEY` is required for the
editor to work at all: without the other two, everything else is unchanged
and the Idea tab and voice controls say that part is not set up here.

The ElevenLabs key travels the way the provider asks — in an `xi-api-key`
header — attached inside the function and never present in the browser. On
the ElevenLabs key itself: **scope it** to text to speech, speech to speech,
voices read, voices write and models read (it creates and deletes its own
throwaway clones, so voices write is not optional); **set a credit quota**,
which is the only hard ceiling on what a bad afternoon can cost; and **do not
use IP allowlisting**, because these requests come from Netlify functions
whose egress addresses are neither fixed nor published, so every one of them
would come back 403.

Then decide who is allowed to spend them. `/api/fal/*`, `/api/anthropic/*`
and `/api/elevenlabs/*` all generate on your accounts, so all three verify
the caller's Auth0 access token before attaching a key:

- **`AUTH0_DOMAIN` and `AUTH0_AUDIENCE`** are what it verifies against — the
  tenant whose published keys must have signed the token, and the API identifier
  its `aud` must include. Both fall back to their `VITE_` forms, which name the
  same tenant and API. Verification is local, with no round trip per request,
  which matters because a single video job polls for minutes.
- **Without either, all three proxies refuse every request** rather than
  running open. `FAL_PROXY_ALLOW_ANONYMOUS=1` overrides that for local
  `netlify dev`; setting it on a deployed site hands your fal, Anthropic and
  ElevenLabs credits to anyone who finds the URL. Netlify's own password
  protection or access controls are worth adding on top if the site is not
  meant to be public at all.
- **The ElevenLabs proxy is narrower than the fal and Anthropic ones**,
  because a key that can speak can also read the account and empty its voice
  library. On the site's own key it forwards only the handful of endpoints
  this editor calls, refuses to delete any voice this app did not create, and
  sweeps away its own abandoned clones when the library fills up. Each rule
  and the reason for it is in `netlify/lib/elevenlabs.ts`, where they are
  also tested.

The `VITE_AUTH0_*` and `VITE_SUPABASE_*` variables are build-time
and not secret — the anon key is protected by row-level security, and the client
ID by origin allowlisting.

**`AUTH0_BACKEND_CLIENT_SECRET`** is what is required if you want anyone to be
able to sign in and save, alongside the dashboard steps in [what sign-in
needs](#what-sign-in-needs).

**`GITHUB_TOKEN` and `GITHUB_REPO`** are optional, and only decide whether the
report bubble can file anything. Without them the editor is unchanged and the
bubble says reporting is not set up. See [letting a deployment file
issues](#letting-a-deployment-file-issues).

## How it fits together

```
Browser (React + TypeScript + Tailwind)          Netlify Functions (stateless pass-through)
  Settings  — one key, in memory or local          /api/fal/*        → queue.fal.run
  Generate  — images, then image → video             Auth0 token verified locally,
  Library   — blobs in IndexedDB                     site's key attached
  Idea      — scene ideas from Claude              /api/anthropic/*  → api.anthropic.com
  Timeline  — picture + audio + caption lanes         Auth0 token verified locally,
  Captions  — words with their own timings            site's key attached
  Speech    — audio decoded here, Scribe there     /api/elevenlabs/* → api.elevenlabs.io
  Sign-in   — Auth0 (auth0-spa-js)                    Auth0 token verified locally,
  Projects  — timelines in Supabase (no media)         site's key attached
  Drive     — media in your own Drive              /api/media        → streams provider media
  Preview   — custom player over <video>           /api/google/*     → oauth2.googleapis.com
  Export    — ffmpeg.wasm → MP4, captions burnt in    exchanges the caller's Auth0 token
  Publish   — that same MP4, into Mintspace            through Token Vault for a Google one
  Report    — bug reports, filed as issues          /api/github/*     → api.github.com
                                                       files what the report form collected,
                                                       attributed to the verified session

                                                 Supabase, Drive and Mintspace all talk to the
                                                 browser directly, not through us — Supabase
                                                 trusts the Auth0 token on its own, and
                                                 Mintspace is signed in to separately.
```

A few decisions worth knowing about:

**Why proxy at all?** Secrecy first: all three keys belong to the deployment
and are attached on the way through, so none of them exists in the browser.
Reliability second — browser-direct calls depend on each provider's CORS
policy, which changes without notice, and going through our own origin makes
it deterministic. And a third payoff they share: provider media arrives
same-origin, so it never taints the canvas during export. The ElevenLabs
proxy carries one job the others do not — deciding what a visitor may do with
the operator's voice library, which is why it has an allowlist rather than
being a pass-through.

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
app's other model calls already go, and at the time it was also the difference
between needing a key from the visitor and not. Both keys belong to the
deployment now, so that half no longer separates them — what does is that fal
already had the queue, the proxy and the spend controls this app drives
everything else through, and one transcript is not a reason to have two ways of
asking the same company for the same thing.

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

**The panel folds up around the transcript.** Styling is a card you use once;
the transcript is where the rest of the session happens. It starts closed and
keeps a summary in its header, so the state is legible without opening it.
Whether it is open is a view preference and deliberately not saved — a fresh
load starts compact however it was left.

There is no setup card above it any more. It held a language picker, a paragraph
on what Scribe is and a warning about what redoing replaces, none of which was
read twice, all of which stood between the press and the words. What is left is
the button and what pressing it will cost. The language went with it: Scribe
detects one per clip, which is a better answer than a single project-wide
setting for a timeline whose clips need not all be in the same language, so no
`languageCode` is sent from either way in — the panel or a clip's ⋯ menu.

**The style sliders print their values.** Size and height are fractions of the
frame, and a slider on its own only says "about here" — which is no help when
the job is to put a caption back exactly where it was, or to match one project
to another. The number sits beside each slider and is also its `aria-valuetext`,
so the raw `0.08` is not what gets announced either. Size is written to one
decimal because it moves in half-percent steps, and a whole-percent readout
would print 8% for two different sizes.

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

**The words page is a page, not a tab.** It is a different job from the editor:
the editor is one project being cut together, and the words page is a growing
shelf of words with a handful of whole takes filed under each. They share media
storage and nothing else — no timeline, no clips, no export — so putting it in
the step nav would have made it step six of a project it has nothing to do with.
Which page is on screen comes off the URL hash (`src/lib/route.ts`), which is
about as much router as two pages need, and it is the hash rather than the path
because Auth0 returns from Google to this same URL with `code` and `state` in the
_query_ string: the hash is the one part of the address that return cannot
disturb. `src/Root.tsx` picks between the two and owns the pair of things both
need — the asset catalogue and the ingest hook — so a video uploaded for a word
reaches Drive by exactly the route a generated image does.

**A word's videos are ordered by hand, and the labels are only labels.** Intro,
Word and Outro say what a take _is_; they do not say where it goes. The run plays
in the order it is listed, so somebody who wants two intros, or the outro in the
middle for a minute, gets to have that — sorting the run by label would be the
page overruling the drag that was just made. Reordering is offered twice, as a
drag handle and as a pair of arrows on each row, because a drag handle is
invisible to a keyboard; both call the same `moveVideo`, so neither can drift.

**Word videos are catalogued without joining a library.** Every other panel hands
new media to `useAssetStore.add`, which also claims it for the open project —
that is what stops a generated file from ending up on the machine with nothing on
screen to reach it by. A word's takes have somewhere else to be reached from, so
they go through `adopt` instead and stay out of the project's library, where they
would only be clutter. The bytes are cleared when the last word listing them is
deleted (`isVideoAssetOrphaned`).

**The folder tree is the shelf.** See below — it is the one decision on that page
big enough to deserve its own section.

## The word shelf in your Drive

The [word pages](#what-it-does) keep their shelf as folders in the Drive folder
you chose, in the layout anybody would build by hand:

```
editor-cat/                       the folder you chose at sign-in
  1st tier/                       a tier
    French/                       a language taught in it
      cerville - brain/           a word
        intro.mp4                 its takes, in the order the sidecar gives
        cerville.mp4
        editor-cat.json           the order, the labels and the transcripts
      bonjour - hello/
        ...
    German/
      ...
  ESL/
    French/                       the same language, a different shelf
      ...
```

**Three levels, because the top one is not a property of a language.** The same
language is taught in more than one tier and its words are not the same words:
French in the first tier and French in ESL share a name and nothing else. So each
gets its own folder under its own tier, and the app matches a language by folder
first and by name _within a tier_ second — never across them, which would merge
two shelves that only look alike.

**Why folders rather than a table.** The obvious alternative was another Supabase
table beside the projects one. Folders won because of what they cost and what
they buy: no schema, no migration, no row-level security policy, and a shelf that
is legible in Drive without this app — the videos for a word are where you would
go looking for them from a phone, in a folder named after the word. Adding a tier,
a language or a word creates its folder there and then, so the place to drop takes
into exists before there are any.

**A folder cannot hold an order, so one small file does.** `editor-cat.json` in
each word folder lists that word's takes by Drive file id, in order, with the
label and transcript for each (`buildSidecar`/`parseSidecar` in
`src/lib/words.ts`). The folder still says which videos there _are_ — drop one in
from a phone and it joins the end of the run, labelled as the word itself — and
the sidecar says what they are and what order they go in. A sidecar that has been
mangled or will not download is read as absent: what is lost is the order and the
labels, not the videos. It is rewritten a beat after the last edit rather than on
every keystroke, and again when an upload finishes, since a take has no Drive id
to be listed under until it is up there.

**Reading it back is what makes it a link rather than a tidier upload.** Opening
the page lists the folders three levels down, matches them against what this
browser already had — by folder id first, then by name, so a tier or language
added offline adopts its folder rather than growing a second one — and folds in
anything new (`mergeShelf`). Only
the folder names and the sidecars come down at that point; a take's bytes are
fetched when you open the word that has it, which is the same
metadata-first-bytes-second order the editor hydrates a project in.

**Deleting reaches Drive, which is a departure.** Everywhere else in this app your
Drive copy is left alone. Here it cannot be: a take removed from a word and left
sitting in that word's folder would simply be found again on the next read and
come back from the dead. So removing a take trashes its file, and deleting a word,
a language or a tier trashes the folder — which takes everything inside it, and is
Drive's own bin, where a mis-click is recoverable. The confirmation says so. The
same reasoning runs the other way: a word whose folder the read did not turn up
has been deleted from another machine, and goes here too, or it would sit on this
machine forever with no way to get rid of it. Pruning runs top down, so a tier
that has gone takes its languages and their words with it. Nothing without a
folder id is ever dropped — that is work made here that Drive has not been told
about yet.

**None of it is required.** With no Drive connection there are no folder ids, no
reads and no writes, and the page is exactly the local one it would have been.
That is one check (`driveRoot`) rather than a scattering of them.

## Testing

```bash
npm test          # unit tests — timeline maths, caption grouping and retiming,
                  # the karaoke subtitle file, reading Scribe's word list, ffmpeg
                  # argv, SSRF guard, session
                  # verification and persistence, the Drive connection flow, the
                  # video request body, orientation, key storage, and what the
                  # report bubble will and will not file
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
`src/lib/supabase/session.test.ts` pins which of Auth0's two tokens PostgREST is
handed, because sending the wrong one does not fail loudly — it verifies, reads
as `anon`, and returns an empty project list. `netlify/lib/auth.test.ts` signs
real RS256 tokens with a real key pair and feeds them to the real
`requireSession`, because a token nobody accepts looks exactly like a user who is
not signed in, and one accepted too readily looks like nothing at all.
`src/lib/google/oauthPopup.test.ts` and `identity.test.ts` pin the parameters
the Drive grant rests on — `access_type=offline` and `prompt=consent` for a
refresh token that outlives the tab, `login_hint` so the second consent screen
does not also ask which account, and the Drive scopes actually reaching the
request. And `src/components/SignInGate.test.tsx` holds the gate rules that
decide whether anyone can use the app — no entry without Drive, no Drive prompt
before there is an account to file it under, and no ejection once inside.

`src/components/FeedbackBubble.test.tsx` is there for the same kind of reason. It
holds the rule that nothing reaches GitHub until Post is pressed, and that what
the issue will publish — the reporter's own address included — is on screen
first. `netlify/lib/github.test.ts` covers what is written once it has been: the
caps, the neutralising that stops a report notifying a stranger, and that the
address on an issue can only come from the verified session and never from the
request body.

`e2e/smoke.mjs` walks the whole product — including recording two overlapping
takes and checking that the second one lands on a new track, cutting a clip and
reloading the page to see the cut come back, putting a count-in in front of the
video and then dragging both it and the picture's lead-in, correcting a clip's
captions and having them said back a line at a time on their own marks, and
counting the inked pixels in the waveform lane, since an undecoded file leaves a
canvas that looks fine and shows nothing — then parses the
exported MP4 to confirm it has the tracks it should and runs for exactly as long
as the export dialog promised, which is how the black at the head is known to
have been encoded rather than merely requested. It earns its keep: it is
what caught the ffmpeg core being loaded as UMD when Vite's module worker needs
ESM. The reload is there because the round trip through IndexedDB is the one
part of persistence a unit test cannot stand in for.

If your CI image ships its own browser, point the test at it with
`CHROMIUM_PATH=/path/to/chrome`.

## Known limits

- **A folder you made by hand is invisible to the word pages.** The app holds the
  narrowest Drive scope there is — `drive.file`, per-file access to what it
  created or you handed it — so it can see the language and word folders it made
  and nothing else of your Drive. If you already have a `Spanish/gato/` tree in
  there, the app cannot find it and will make its own; move your videos into the
  folder it made, or drop them into it from Drive, and they turn up in the app on
  the next visit. The alternative is `drive.readonly`, which puts "see and
  download all your Google Drive files" on the consent screen.
- **Deleting on the word pages deletes in Drive.** Unlike the Library, which
  never touches your Drive copy, removing a take trashes its file and deleting a
  word or language trashes the folder — because the folder _is_ the list, and
  anything left in it comes back on the next read. It is Drive's bin rather than
  a permanent delete, and the confirmation says so.
- **A language saved before the shelf had tiers is left out.** The word pages
  briefly kept languages directly in the chosen folder, with no tier above them.
  Those rows are skipped on load rather than guessed at, because their folders sit
  where tier folders live now. Nothing in Drive is touched: move such a folder
  under a tier folder and the next visit reads it back in.
- **Two machines editing the same word at once will not merge.** Each writes the
  whole sidecar for that word, so the last write wins for the order and the
  labels. The videos themselves are never lost this way — they are files in the
  folder, and both machines see all of them.
- **A filed report is one-way.** The issue carries the reporter's address so
  they can be answered, but nothing comes back into the editor — there is no
  inbox in the app, and someone who files a bug and closes the tab will only
  hear about it by email or by opening the issue themselves.
- **Getting in costs two trips to Google.** One signs you in, the other grants
  Drive. Not a limit of the login — Auth0 will carry the scope through it — but
  of where the result lands: a login files Google's tokens against the user's
  identity, and Token Vault reads `connected_accounts`, which only the connect
  flow writes. The second trip is asked with the first one's address as a hint,
  so it is one approval rather than another choice of account.
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
- **A source is captioned whole or not at all.** Captioning a timeline is a
  queue of requests rather than one, so the failure that actually happens is one
  of them coming back rate limited while the rest are fine. Each is asked for up
  to three times, a second's wait and then two seconds between goes, and the
  progress line says which go it is on so a quiet moment reads as a wait rather
  than a hang. What survives that is settled rather than unlucky: the source is
  named in the warning list with the reason and how many tries it had, and none
  of its words reach the timeline — not even the chunks that came back fine
  before the one that did not. Every other source is unaffected, and pressing
  the button again re-transcribes all of them. Answers the provider has already
  made up its mind about — a lapsed sign-in, a refused input — are not retried
  at all, since they do not change in three seconds; nor is a request that ran
  out of time, which would only be sent again at the same size and take just as
  long.
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
- **A fixed line is not lip-synced, and not stretched to fit.** Each line starts
  where its caption starts, which keeps the new speech tracking the performance,
  but the mouth on screen is still shaping the words that were originally said.
  Nothing time-stretches the new reading either: a line that takes longer than
  the old one pushes the next line later, and the last line can run on past the
  end of its clip. Shorten the text, or give the captions more room. A quicker
  reading moves the next line earlier instead, by at most the room the quick one
  left — so a line can sit slightly ahead of its caption's original mark, and the
  run says how many did.
- **Fixing a clip needs its captions to exist first**, or it falls back to one
  piece of audio at the head of the clip with no line-by-line timing at all. The
  captions carry the marks; without them there is nothing to lay the speech
  against.
- **Copying a clip's voice needs an ElevenLabs plan that allows cloning.** An
  account that refuses says so, and the answer is to pick a ready-made voice in
  the same dialog — a stranger's voice under the clip, but the right words in it.
  The copy is deleted as the run ends, including when it fails; a browser closed
  mid-run can still leave one behind, which matters more on a shared deployment
  than it would on your own account because voice slots are finite. Those
  leftovers are named after the clip they came from, and the proxy sweeps the
  abandoned ones the first time a new clone is refused for want of a slot, so
  the feature repairs itself rather than quietly stopping.
- **Every fix adds a lane.** Nothing generated is thrown away, so fixing one clip
  four times leaves four rows: the newest audible and the three before it muted.
  That is deliberate — you paid for each of them and only listening tells you
  which reading was best — but the lanes are yours to delete once you have
  chosen, and nothing prunes them for you.
- **Only the picture track's clips can be fixed.** Clips on a video lane are
  layered over the picture rather than into it; mute one and lay a voiceover
  under it by hand if its dialogue is wrong.
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
- **The editor knows only about its own posts.** It remembers what it published
  and can delete those, but it cannot list what is in the feed, edit a caption
  after the fact, or see a video posted from anywhere else. A post deleted in
  Mintspace itself stays listed here until the next time you try to delete it.
  The success message links the feed rather than the post, because Mintspace has
  no per-video route to link to.
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
