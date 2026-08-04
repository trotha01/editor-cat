# editor-cat

A small AI video editor that runs in your browser.

Write a prompt → get images → animate one into a clip → arrange clips on a
timeline → record a voiceover → swap your voice for another one → export an MP4.

Every AI feature uses **your own API keys**. This app has no accounts, no
provider credentials, and no server-side storage of its own.

---

## What it does

| Step          | What happens                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Image** | Generate images from a text prompt. **Improve with AI** rewrites the prompt with composition, lighting and lens detail.                                                                  |
| **2 · Video** | Pick a generated image as the opening frame and animate it. **Improve with AI** here is tuned differently — it describes _motion and camera_, since the model can already see the frame. |
| **Timeline**  | Drag clips to reorder, drag their edges to trim, set how long stills stay on screen.                                                                                                     |
| **3 · Voice** | Record a voiceover against the playing preview, then convert it into another voice with ElevenLabs. Your original take is always kept.                                                   |
| **Export**    | Render an MP4 in the browser with ffmpeg compiled to WebAssembly. Nothing is uploaded.                                                                                                   |

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

## Deploying to Netlify

The repo is deploy-ready; `netlify.toml` already declares the build command,
publish directory, functions directory, SPA fallback and security headers.

1. In Netlify, **Add new site → Import an existing project**.
2. Pick this repository. The build settings are detected from `netlify.toml`.
3. Deploy.

**No environment variables are needed.** That falls out of the bring-your-own-key
design: the keys arrive from the browser on each request, so the deployment
holds no secrets at all.

Note that anyone who visits your deployed URL can use it with _their_ keys, and
the proxy will forward for any caller. If you would rather it not be public, add
Netlify password protection or access controls to the site.

## How it fits together

```
Browser (React + TypeScript + Tailwind)      Netlify Functions (stateless pass-through)
  Settings  — keys, in memory or local          /api/fal/*        → queue.fal.run
  Generate  — images, then image → video        /api/elevenlabs/* → api.elevenlabs.io
  Library   — blobs in IndexedDB                /api/media        → streams provider media
  Timeline  — one visual track + voiceover
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

**Clip audio is muted.** The exporter mixes only your voiceover, so the preview
mutes clips to match. Hearing something in preview that vanished from the export
would be worse than silence.

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
`src/lib/timeline.ts` (clip layout, trim clamping) and
`src/lib/export/buildGraph.ts` (the exact ffmpeg arguments, asserted without
running ffmpeg). `netlify/lib/proxy.test.ts` covers the media proxy's
allowlist, including the cloud-metadata address and lookalike hostnames.

`e2e/smoke.mjs` walks the whole product and then parses the exported MP4 to
confirm it has the tracks and duration it should. It earns its keep: it is what
caught the ffmpeg core being loaded as UMD when Vite's module worker needs ESM.

If your CI image ships its own browser, point the test at it with
`CHROMIUM_PATH=/path/to/chrome`.

## Known limits

- **Audio from clips is not exported.** Most image-to-video models return silent
  footage, and mixing per-clip audio requires knowing which files have an audio
  track at all. Your voiceover is the soundtrack.
- **Export uses the single-threaded ffmpeg build**, so a short project takes
  roughly 30–90 seconds. The multithreaded build needs cross-origin isolation
  (COOP/COEP), which would block loading provider media in the page.
- **One visual track, no transitions or text overlays.** This is deliberate —
  clips sit end to end with no gaps, which removes most of what makes a
  timeline confusing.

## Licence

MIT
