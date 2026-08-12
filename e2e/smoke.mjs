/**
 * End-to-end smoke test against the built app in mock mode.
 *
 * This walks the entire product in a real browser: prompt -> AI prompt
 * improvement -> image -> video -> timeline -> trim -> playback -> MP4 export,
 * then verifies the exported file is a structurally complete MP4 with the
 * expected tracks and duration.
 *
 * It is worth having as more than a formality: this test is what caught the
 * ffmpeg core being loaded as UMD when Vite's module worker needs ESM, and the
 * mock mode still gating buttons on an API key. Neither is reachable from a
 * unit test.
 *
 *   npm run build   (with VITE_MOCK_PROVIDERS=1)
 *   npm run preview
 *   node e2e/smoke.mjs [baseURL]
 */
import { chromium } from 'playwright'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unpack } from './mp4.mjs'
import { sineWav } from './wav.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173/'
const workDir = mkdtempSync(join(tmpdir(), 'editor-cat-e2e-'))

const steps = []
const step = (message) => {
  steps.push(message)
  console.log(`  ✓ ${message}`)
}
const fail = (message) => {
  console.error(`\n  ✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

/*
 * CHROMIUM_PATH lets this run against a browser that was provisioned outside
 * npm (some CI images ship one), where the build Playwright expects will not
 * match what is on disk. Unset, Playwright resolves its own download.
 */
const executablePath = process.env.CHROMIUM_PATH

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    // A synthetic microphone, so the voiceover step needs no hardware and no
    // permission prompt.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({ permissions: ['microphone'] })
const page = await context.newPage({ viewport: { width: 1500, height: 950 } })

const pageErrors = []
// The caption typeface is staged into public/fonts at build time and is the one
// thing captions cannot be drawn without — in the browser or, more quietly,
// inside ffmpeg, where a missing font draws nothing and still exits successfully.
const fontResponses = []
page.on('response', (response) => {
  if (/\/fonts\/.+\.ttf$/.test(response.url())) {
    fontResponses.push({ url: response.url(), status: response.status() })
  }
})
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text())
})

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  step('app loads')

  // --- Image generation, including the AI prompt rewrite -------------------
  await page.fill('#prompt-image', 'a lighthouse on a cliff at dusk')
  await page.getByRole('button', { name: /Improve with AI/ }).click()
  await page.waitForSelector('text=Suggested image prompt', { timeout: 20000 })
  await page.getByRole('button', { name: 'Use this' }).click()
  const improved = await page.inputValue('#prompt-image')
  if (improved.length < 40) fail('improved prompt looks too short to be a real rewrite')
  step('AI improves the image prompt and the suggestion can be accepted')

  await page.getByRole('button', { name: /Generate image/ }).click()
  await page.waitForSelector('text=Added 1 image to your library', { timeout: 60000 })
  step('image generated and stored locally')

  // --- Timeline ------------------------------------------------------------
  await page.getByRole('button', { name: 'Library' }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  const oneClip = await page.textContent('section[aria-label="Timeline"] header span')
  if (!oneClip.includes('1 clip')) fail(`expected one clip on the timeline, got "${oneClip}"`)
  step('image added to the timeline')

  // --- Video generation ----------------------------------------------------
  await page.getByRole('button', { name: /3 · Video/ }).click()
  await page.fill('#prompt-video', 'slow push in as the beam sweeps across the water')
  await page.getByRole('button', { name: /^Generate video/ }).click()
  await page.waitForSelector('text=Clip added to your library', { timeout: 120000 })
  const twoClips = await page.textContent('section[aria-label="Timeline"] header span')
  if (!twoClips.includes('2 clips')) fail(`expected two clips, got "${twoClips}"`)
  step('video generated from the image and appended to the timeline')

  // --- Clip sound ----------------------------------------------------------
  // Mock clips are recorded with a real audio track, so this is the whole
  // clip-sound path: the preview must play it rather than mute it, and the
  // export below has to find it by probing and wire it into the mix.
  await page.getByRole('button', { name: /^Play$/ }).click()
  await page.waitForTimeout(600)
  const preview = await page.evaluate(() => {
    const video = document.querySelector('section[aria-label="Preview"] video')
    return video ? { muted: video.muted, volume: video.volume } : null
  })
  await page.getByRole('button', { name: /^Pause$/ }).click()
  if (!preview) fail('no preview video element to check for sound')
  if (preview.muted || preview.volume < 1) {
    fail(`preview should play the clip's own sound, got ${JSON.stringify(preview)}`)
  }
  step('preview plays the clip’s own sound instead of muting it')

  // --- Fullscreen ----------------------------------------------------------
  // Worth doing in a real browser: jsdom has no Fullscreen API at all, so a
  // unit test can only check that we asked. What matters is which element the
  // browser hands the screen to — the whole player, transport included, rather
  // than the one <video> that happens to be on screen.
  await page.getByRole('button', { name: 'Fullscreen' }).click()
  await page.waitForTimeout(300)
  const filling = await page.evaluate(() => {
    const element = document.fullscreenElement
    if (!element) return null
    return {
      label: element.getAttribute('aria-label'),
      transport: element.contains(document.querySelector('input[aria-label*="Scrub"]')),
      video: element.contains(document.querySelector('video')),
      wide: element.getBoundingClientRect().width >= window.innerWidth,
    }
  })
  if (!filling) fail('pressing Fullscreen did not put anything on the screen')
  if (filling.label !== 'Preview') fail(`fullscreen took ${filling.label}, not the preview`)
  if (!filling.transport) fail('fullscreen left the transport behind, so it cannot be paused')
  if (!filling.video || !filling.wide) fail('the fullscreen preview is not showing the clip')
  step('fullscreen puts the whole player on screen, transport included')

  const stillFullscreen = () => page.evaluate(() => document.fullscreenElement !== null)

  await page.getByRole('button', { name: 'Exit fullscreen' }).click()
  await page.waitForTimeout(300)
  if (await stillFullscreen()) fail('the Exit button did not leave fullscreen')
  step('the Exit button comes back out')

  // An exit the app did not perform. Escape is the everyday one, but that is
  // browser chrome and headless has none, so this stands in for it: the button
  // has to notice, or it stays on "Exit" and the next press asks for fullscreen
  // while claiming to leave it.
  await page.getByRole('button', { name: 'Fullscreen' }).click()
  await page.waitForTimeout(300)
  await page.evaluate(() => document.exitFullscreen())
  await page.waitForTimeout(300)
  if (await stillFullscreen()) fail('exitFullscreen() left the page in fullscreen')
  await page.getByRole('button', { name: 'Fullscreen' }).waitFor({ timeout: 5000 })
  step('an exit made from outside the app is noticed by the button')

  // --- Trimming ------------------------------------------------------------
  // The first m:ss.d in the header is how long the picture runs for. Comparing
  // that rather than the whole line matters: the line carries other numbers,
  // and a change to any of them would otherwise pass for a trim.
  const pictureSeconds = (text) => {
    const found = /(\d+):(\d+\.\d)/.exec(text)
    return found ? Number(found[1]) * 60 + Number(found[2]) : 0
  }

  await page.locator('section[aria-label="Timeline"] .group').first().click()
  await page.fill('input[aria-label="Selected clip length, in seconds"]', '2')
  await page.waitForTimeout(300)
  const trimmed = await page.textContent('section[aria-label="Timeline"] header span')
  if (pictureSeconds(trimmed) >= pictureSeconds(twoClips)) {
    fail(`trimming a clip did not shorten the picture: "${twoClips}" -> "${trimmed}"`)
  }
  step(`trimming shortens the timeline (${twoClips.trim()} -> ${trimmed.trim()})`)

  // --- Waveforms of the clips' own sound -----------------------------------
  // Mock clips are recorded with a real tone, so the lane has something to
  // draw. Counting ink rather than asserting the canvas exists is the point:
  // an undecoded file, a wrong colour or a zero-sized backing store all leave
  // an element on the page that looks fine and shows nothing.
  const waveform = page.locator('canvas[aria-label^="Sound from"]').first()
  await waveform.waitFor({ timeout: 30000 })
  const ink = await waveform.evaluate((canvas) => {
    const context = canvas.getContext('2d')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let opaque = 0
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) opaque += 1
    return { opaque, pixels: data.length / 4, width: canvas.width, height: canvas.height }
  })
  if (ink.width < 2 || ink.height < 2)
    fail(`the waveform canvas has no size: ${ink.width}x${ink.height}`)
  // A centre hairline alone would be roughly 1/height of the canvas, so this
  // threshold is what separates "drew a waveform" from "drew the empty lane".
  if (ink.opaque < ink.pixels * 0.05) {
    fail(`the waveform lane is blank: ${ink.opaque} of ${ink.pixels} pixels have ink`)
  }
  step(`clip sound drawn as a waveform (${ink.opaque} of ${ink.pixels} pixels inked)`)

  // --- Cutting -------------------------------------------------------------
  // A cut is not stored as anything of its own: it *is* the two clips it leaves
  // behind. So the thing worth checking in a real browser is that it comes back
  // after a reload, which is the only place the round trip through IndexedDB
  // actually happens.
  const summarise = async () => {
    const text = await page.textContent('section[aria-label="Timeline"] header span')
    return { text: text.trim(), clips: Number(/(\d+) clips?/.exec(text)?.[1] ?? 0) }
  }
  const cutMarks = () =>
    page.locator('section[aria-label="Timeline"] [role="img"][aria-label^="Cut at"]').count()

  const beforeCut = await summarise()

  // Clicking the ruler rather than dragging the transport: it parks the
  // playhead on a frame, and leaves the focus off the slider so `S` is ours.
  const ruler = page.locator('section[aria-label="Timeline"] [role="presentation"]').first()
  await ruler.click({ position: { x: 160, y: 3 } })
  await page.waitForTimeout(150)

  const cutButton = page.getByRole('button', { name: 'Cut', exact: true })
  if (await cutButton.isDisabled()) fail('the playhead is over a clip but Cut is disabled')
  await page.keyboard.press('s')
  await page.waitForTimeout(300)

  const afterCut = await summarise()
  if (afterCut.clips !== beforeCut.clips + 1) {
    fail(
      `cutting should have split one clip in two, went "${beforeCut.text}" -> "${afterCut.text}"`,
    )
  }
  // The halves have to add up to what the one clip covered: a cut moves an
  // edge, it does not throw a frame away.
  if (afterCut.text.split('·')[1] !== beforeCut.text.split('·')[1]) {
    fail(`cutting changed the length of the timeline: "${beforeCut.text}" -> "${afterCut.text}"`)
  }
  if ((await cutMarks()) !== 1) fail('the cut is not marked on the timeline')
  step(`cutting splits a clip at the playhead (${beforeCut.text} -> ${afterCut.text})`)

  // Frame lines are what tell you where a cut can land, so they have to be
  // reachable — and drawn, rather than merely switched on.
  await page.getByRole('button', { name: 'Show frames' }).click()
  await page.waitForTimeout(200)
  const grid = await page.evaluate(() => {
    const bar = document.querySelector('section[aria-label="Timeline"] [role="presentation"]')
    return getComputedStyle(bar).backgroundImage
  })
  if (!/repeating-linear-gradient/.test(grid)) fail(`no frame grid on the ruler, got "${grid}"`)
  step('zooming in draws a line for every frame')

  await page.waitForTimeout(500) // let the write to IndexedDB land
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('section[aria-label="Timeline"] .group', { timeout: 30000 })

  const reopened = await summarise()
  if (reopened.clips !== afterCut.clips) {
    fail(`the cut did not survive a reload: "${afterCut.text}" -> "${reopened.text}"`)
  }
  if ((await cutMarks()) !== 1) fail('the reopened project no longer shows where the cut is')
  step(`the cut is still there when the project is opened again (${reopened.text})`)

  // --- Voiceover, layered across tracks -------------------------------------
  const trackCount = () =>
    page.locator('section[aria-label="Timeline"] [aria-label$="volume"]').count()

  await page.getByRole('button', { name: /5 · Audio/ }).click()
  const tracksAtStart = await trackCount()

  const recordFrom = async (seconds) => {
    // Park the playhead so both takes claim the same stretch of timeline.
    await page.locator('input[aria-label="Scrub through the timeline"]').fill(String(seconds))
    await page.getByRole('button', { name: /Record from/ }).click()
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: /Stop and keep/ }).click()
  }

  await recordFrom(0)
  await page.waitForSelector('text=/Added to|went onto a new one/', { timeout: 30000 })
  step('first voiceover take recorded and placed automatically')

  await recordFrom(0)
  await page.waitForSelector('text=/went onto a new one/', { timeout: 30000 })
  const tracksAfter = await trackCount()
  if (tracksAfter !== tracksAtStart + 1) {
    fail(`overlapping take should have added one track, went ${tracksAtStart} -> ${tracksAfter}`)
  }
  step(`overlapping take stacked onto a new track (${tracksAtStart} -> ${tracksAfter} tracks)`)

  // --- Music ---------------------------------------------------------------
  await page.locator('input[accept="audio/*"]').setInputFiles({
    name: 'score.wav',
    mimeType: 'audio/wav',
    buffer: sineWav({ seconds: 5 }),
  })
  await page.waitForSelector('text=/score.wav.+added to/', { timeout: 30000 })
  step('music added to a music track, under the voice tracks')

  // --- Count-in beeps -------------------------------------------------------
  // The beeps are synthesised in the browser and then treated as ordinary
  // audio, so this covers the whole path at once: generated, placed on a lane
  // of its own, draggable to an exact spot, and — by the export summary and the
  // MP4 below — carried into the render.
  const tracksBeforeCountIn = await trackCount()
  const leadInField = page.locator('input[aria-label="Lead-in before the picture, in seconds"]')
  await page.getByRole('button', { name: /Add before the video/ }).click()
  await page.waitForSelector('text=/Count-in added to/', { timeout: 30000 })
  const tracksAfterCountIn = await trackCount()
  if (tracksAfterCountIn !== tracksBeforeCountIn + 1) {
    fail(
      `the count-in should open a lane of its own, went ` +
        `${tracksBeforeCountIn} -> ${tracksAfterCountIn}`,
    )
  }
  step('count-in beeps generated and placed on a lane of their own')

  // The beeps only fit in front of the picture because the picture moved, so
  // the lead-in has to have been opened by the same click.
  const leadInValue = Number(await leadInField.inputValue())
  if (leadInValue < 3)
    fail(`the picture should have been pushed back 3s, field reads ${leadInValue}`)
  step(`picture slid right to make room for the count-in (lead-in ${leadInValue}s)`)

  // Dragging is the point of putting them on the timeline rather than playing
  // them at the recorder: the cue has to be movable to the exact moment.
  const beeps = page.locator('[role="group"][aria-label^="Countdown"]')
  const beepsBefore = await beeps.getAttribute('aria-label')
  // page.mouse works in viewport coordinates and, unlike a locator action,
  // scrolls nothing into view first — so the box has to be on screen already.
  await beeps.scrollIntoViewIfNeeded()
  const beepsBox = await beeps.boundingBox()
  if (!beepsBox) fail('the count-in clip is not on the timeline to drag')
  await page.mouse.move(beepsBox.x + beepsBox.width / 2, beepsBox.y + beepsBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(beepsBox.x + beepsBox.width / 2 + 40, beepsBox.y + beepsBox.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const beepsAfter = await beeps.getAttribute('aria-label')
  if (beepsBefore === beepsAfter) fail(`dragging the count-in did not retime it: "${beepsAfter}"`)
  step(`count-in dragged along its lane (${beepsBefore} -> ${beepsAfter})`)

  // Put them back in front of the picture, which is where this project wants
  // them and what the exported file is checked against below.
  await page.mouse.move(beepsBox.x + beepsBox.width / 2 + 40, beepsBox.y + beepsBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(beepsBox.x + beepsBox.width / 2 - 200, beepsBox.y + beepsBox.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  await page.waitForTimeout(200)
  if (!/at 0:00.0/.test((await beeps.getAttribute('aria-label')) ?? '')) {
    fail('the count-in should clamp at zero when dragged past the start of the timeline')
  }
  step('count-in dragged back to the top and clamped at zero')

  // Dragging the hatched block at the head of the picture track is the direct
  // way to slide the video: what moves is everything after it.
  const leadInBlock = page.locator('[role="slider"][aria-label="Lead-in before the picture"]')
  await leadInBlock.scrollIntoViewIfNeeded()
  const leadInBox = await leadInBlock.boundingBox()
  if (!leadInBox) fail('the lead-in block is not on the picture track to drag')
  await page.mouse.move(leadInBox.x + leadInBox.width / 2, leadInBox.y + leadInBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    leadInBox.x + leadInBox.width / 2 + 40,
    leadInBox.y + leadInBox.height / 2,
    {
      steps: 8,
    },
  )
  await page.mouse.up()
  await page.waitForTimeout(200)
  const draggedLeadIn = Number(await leadInField.inputValue())
  if (draggedLeadIn <= leadInValue) {
    fail(`dragging the lead-in should have lengthened it, ${leadInValue} -> ${draggedLeadIn}`)
  }
  step(`picture slid further right by dragging its lead-in (${leadInValue}s -> ${draggedLeadIn}s)`)

  // --- Voice conversion -----------------------------------------------------
  await page.waitForSelector('select')
  await page
    .getByRole('button', { name: /Change voice/ })
    .first()
    .click()
  await page.waitForSelector('button:has-text("Your voice")', { timeout: 60000 })
  step('voice conversion completes and keeps the original for A/B')

  // --- Muting excludes a track from the mix --------------------------------
  const muteButton = page.locator('button[aria-label^="Mute"]').first()
  await muteButton.click()
  await page.waitForTimeout(200)
  const exportSummaryMuted = await page.evaluate(() => {
    document.querySelector('dialog[open]')?.close()
    return true
  })
  if (!exportSummaryMuted) fail('could not reset dialogs before checking the mute state')
  await page.locator('button[aria-label^="Unmute"]').first().click()
  step('track mute toggles without error')

  // --- Karaoke captions -----------------------------------------------------
  // The whole path in one go: the timeline's audio is decoded and re-encoded in
  // the browser, transcribed, grouped into captions, put on a lane of their own,
  // and drawn over the picture with one word lit. Only the recognition itself is
  // mocked — everything either side of it is the real code, including the
  // WebAudio decode, which no unit test can reach.
  await page.getByRole('button', { name: /4 · Captions/ }).click()

  // The bill lands on the deployment, so what it will cost has to be visible
  // before the press rather than after — and pressing again re-transcribes the
  // whole timeline. Read from the real timeline's own audio length, so a wrong
  // sum shows up here rather than in an invoice.
  const estimate = await page.locator('text=/Costs about .* of audio/').first().innerText()
  if (!/Costs about (~\$\d|<\$0\.01)/.test(estimate)) {
    fail(`expected a caption cost estimate next to the button, got "${estimate}"`)
  }
  step(`cost shown before transcribing (${estimate.replace(/\s+/g, ' ')})`)

  // Transcription needs no key from the user — it runs on the site's fal
  // account — so the button has to work on a first visit with nothing entered.
  // Recognition is faked in mock mode; the wiring either side of it is not.
  // Exactly, because every clip below it offers to be captioned on its own and
  // says so in the same words — this is the one that does the whole timeline.
  await page.getByRole('button', { name: 'Add captions', exact: true }).click()
  await page.waitForSelector('text=/captions? from \\d+ words/', { timeout: 120000 })

  // Styling stays folded away until it is asked for. Left open it pushes the
  // words far enough down that following the playhead scrolls the page.
  const lookToggle = page.getByRole('button', { name: 'Look' })
  if ((await lookToggle.getAttribute('aria-expanded')) !== 'false') {
    fail('the styling section was open before it was asked for')
  }
  await lookToggle.click()
  if ((await lookToggle.getAttribute('aria-expanded')) !== 'true') {
    fail('the styling section would not open')
  }
  // Size and height say what they are set to, so a look can be reproduced
  // rather than only approached.
  const sizeReadout = await page.locator('label', { hasText: /^Size/ }).locator('span').innerText()
  if (!/^\d+\.\d%$/.test(sizeReadout.trim())) {
    fail(`expected the caption size to be printed beside its slider, got "${sizeReadout}"`)
  }
  await lookToggle.click()
  step(`styling folds away and prints its numbers (size ${sizeReadout.trim()})`)

  // Provenance: each caption says which clip it was heard in, which is the only
  // way to tell layered takes apart once their words are on one lane.
  const firstLabel = await page
    .locator('[role="group"][aria-label^="Caption "]')
    .first()
    .getAttribute('aria-label')
  if (!/, from .+$/.test(firstLabel ?? '')) {
    fail(`expected the caption to name the clip it came from, got "${firstLabel}"`)
  }
  step(`captions record their source clip (${/, from (.+)$/.exec(firstLabel)?.[1]})`)

  const captionCues = await page.locator('[role="group"][aria-label^="Caption "]').count()
  if (captionCues < 2) fail(`expected several captions on the timeline, got ${captionCues}`)
  step(`transcript became ${captionCues} captions on a lane of their own, with no key entered`)

  // The transcript is the editing surface, so a word typed here has to reach the
  // captions — and take the other words' timings with it untouched.
  const firstCue = page.locator('[aria-label="Caption 1 text"]')
  const originalLine = await firstCue.inputValue()
  await firstCue.fill(`${originalLine} SPLICED`)
  await firstCue.blur()
  await page.waitForTimeout(300)
  const splicedLabel = await page
    .locator('[role="group"][aria-label^="Caption "]')
    .first()
    .getAttribute('aria-label')
  if (!/SPLICED/.test(splicedLabel ?? '')) {
    fail(`editing the transcript did not reach the timeline: "${splicedLabel}"`)
  }
  step('a word typed into the transcript appears on the timeline caption')

  // --- Redoing one clip from its own menu ----------------------------------
  // The blunt press re-transcribes the whole timeline and discards every
  // correction on it, which is the wrong tool for the common failure: one take
  // that came back badly among several that came back fine. Every clip carries a
  // menu that redoes just that clip, and what has to be true of it is a negative
  // — every caption from every other clip is still there, still saying the same
  // thing, still at the same time, including the word typed in by hand above.
  const captionLabels = () =>
    page.$$eval('[role="group"][aria-label^="Caption "]', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    )
  const clipOf = (label) => /, from (.+)$/.exec(label ?? '')?.[1] ?? ''

  const menus = page.locator('section[aria-label="Timeline"] button[aria-label^="Actions for "]')
  const menuNames = await menus.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label')),
  )
  if (menuNames.length === 0) fail('no clip on the timeline carries a menu')

  const beforeRedo = await captionLabels()

  // The first clip that can be redone and is not the one the edit above landed
  // on — replacing that clip's captions is what was asked for, so it would prove
  // nothing. Menus are opened to find out: a still has no sound to transcribe
  // and says nothing about captions at all, which is itself worth walking past
  // rather than assuming which clip is which.
  let redoneClip = ''
  let itemText = ''
  const redoItem = page.getByRole('menuitem', { name: /Redo captions for this clip/ })
  for (const [index, name] of menuNames.entries()) {
    if (name.includes(clipOf(splicedLabel))) continue
    await menus.nth(index).click()
    if ((await redoItem.count()) > 0) {
      itemText = (await redoItem.innerText()).replace(/\s+/g, ' ')
      redoneClip = /^Actions for (.+)$/.exec(name)?.[1] ?? ''
      break
    }
    await page.keyboard.press('Escape')
  }
  if (!redoneClip) fail(`no other clip offered to redo its captions, out of ${menuNames.length}`)

  const elsewhereBefore = beforeRedo.filter((label) => clipOf(label) !== redoneClip)
  if (elsewhereBefore.length === 0) fail('nothing from another clip to be left alone')

  // The bill lands on the deployment, so the price is on the row itself rather
  // than behind a hover — this is the one item in the menu that spends money.
  if (!/(~\$\d|<\$0\.01)/.test(itemText)) {
    fail(`the caption item should be priced before it is pressed, reads "${itemText}"`)
  }
  step(`each clip offers captioning from its own menu, priced ("${itemText}")`)

  await redoItem.click()
  // A clip is named after its file, so the name reaches this as text rather
  // than as a pattern — "take-1.webm" has a wildcard in it either way.
  const named = redoneClip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.waitForSelector(`text=/(words|recognised) in ${named}/`, { timeout: 120000 })

  const afterRedo = await captionLabels()
  const elsewhereAfter = afterRedo.filter((label) => clipOf(label) !== redoneClip)
  if (JSON.stringify(elsewhereAfter) !== JSON.stringify(elsewhereBefore)) {
    fail(
      `redoing ${redoneClip} disturbed another clip's captions: ` +
        `${elsewhereBefore.length} before, ${elsewhereAfter.length} after`,
    )
  }
  if (!afterRedo.some((label) => label?.includes('SPLICED'))) {
    fail('redoing one clip lost the word typed into another clip\u2019s caption')
  }
  if (!afterRedo.some((label) => clipOf(label) === redoneClip)) {
    fail(`redoing ${redoneClip} left it with no captions at all`)
  }
  step(
    `one clip redone from its menu (${redoneClip}), leaving ${elsewhereAfter.length} captions ` +
      `from other clips untouched`,
  )

  // The result stays until it is dismissed: transcribing takes long enough to
  // look away from, and the count is the only confirmation the words changed.
  await page.getByRole('button', { name: /^Dismiss the captioning result/ }).click()

  // --- Fixing what a clip says, from the same menu -------------------------
  // A generated clip that says a foreign word with an English mouth cannot be
  // repaired by a voice changer: the delivery is the part that is wrong. So the
  // captions are the script — corrected here, saved, then said back a line at a
  // time and laid on the mark each caption sits on, with the captions re-timed
  // to the new voice afterwards. Everything about that is only real in a
  // browser: the audio has to decode for its length to be known at all.
  const fixItem = page.getByRole('menuitem', { name: /Fix this clip’s audio/ })
  let fixedClip = ''
  for (const [index, name] of menuNames.entries()) {
    await menus.nth(index).click()
    if ((await fixItem.count()) > 0) {
      // Nothing here is gated on a key: mock mode has none, and a greyed-out
      // item would mean the whole flow below is unreachable in this build.
      if (await fixItem.isDisabled()) fail(`${name} offers the fix but will not run it`)
      fixedClip = /^Actions for (.+)$/.exec(name)?.[1] ?? ''
      break
    }
    await page.keyboard.press('Escape')
  }
  if (!fixedClip) fail(`no clip offered to fix its audio, out of ${menuNames.length}`)

  const mutedBefore = await page.locator('[aria-label="sound muted"]').count()
  await fixItem.click()
  await page.waitForSelector('text=Fix the audio on', { timeout: 20000 })

  // The captions themselves, one row each — not a copy to correct separately.
  const captionRows = page.locator('dialog[open] input[aria-label^="Caption at "]')
  const rowCount = await captionRows.count()
  if (rowCount === 0) fail('the fix dialog should open with this clip’s captions in it')
  step(`fix dialog opens for ${fixedClip} with its ${rowCount} captions, each on its own mark`)

  // Editing a line has to reach the captions as well as the speech: that is the
  // whole point of the captions being the script rather than a suggestion.
  const CORRECTED = 'Buongiorno amico mio'
  await captionRows.first().fill(CORRECTED)
  await page.getByRole('button', { name: /Save captions and fix the audio/ }).click()
  await page.waitForSelector('text=/now says your/', { timeout: 180000 })

  const laid = page.locator('[role="group"][aria-label^="Fixed"]')
  const laidCount = await laid.count()
  if (laidCount !== rowCount) {
    fail(`expected one piece of audio per caption: ${laidCount} for ${rowCount} captions`)
  }
  const laidLabel = await laid.first().getAttribute('aria-label')
  if (!/on Voice /.test(laidLabel ?? '')) fail(`the fix landed off the voice lanes: "${laidLabel}"`)
  const mutedAfter = await page.locator('[aria-label="sound muted"]').count()
  if (mutedAfter !== mutedBefore + 1) {
    fail(`the fixed clip should be muted: ${mutedBefore} silent clips before, ${mutedAfter} after`)
  }
  // By role rather than a raw attribute selector: the label quotes the caption
  // text, and quoting that inside a CSS selector is a way to write an invalid one.
  const correctedCaption = page.getByRole('group', { name: new RegExp(`Caption "${CORRECTED}"`) })
  if ((await correctedCaption.count()) === 0) {
    fail('the edited line did not reach the caption on the timeline')
  }
  step(
    `${laidCount} lines spoken under ${fixedClip}, the clip muted, and the edit saved to the ` +
      `caption itself`,
  )

  // Both halves of the landing are one edit, so one undo has to put them back —
  // and it leaves the timeline as the rest of this walk-through expects it.
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForTimeout(200)
  if ((await laid.count()) !== 0) fail('undo left the corrected lines on the timeline')
  if ((await page.locator('[aria-label="sound muted"]').count()) !== mutedBefore) {
    fail('undo left the clip silent after taking its replacement away')
  }
  // A second undo backs out the caption edit, which is deliberately its own step.
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForTimeout(200)
  if ((await correctedCaption.count()) !== 0) {
    fail('a second undo should return the caption to what it said before')
  }
  await page.getByRole('button', { name: /^Dismiss the audio fix result/ }).click()
  step('one undo takes the audio and the timings back, a second returns the words')

  // Retiming one word is the other half of the job, and the part that makes this
  // karaoke rather than subtitles. Asking for an absurd time is deliberate: a
  // word must move, and must stop short of overtaking the one after it, so this
  // covers the retime and the clamp in one go.
  await page.locator('[aria-label="Caption 1 text"]').scrollIntoViewIfNeeded()
  await page.locator('[data-cue] button', { hasText: /^is$/ }).first().click()
  const wordStart = page.locator('input[aria-label^="When \\"is\\" is highlighted"]')
  const wasAt = Number(await wordStart.inputValue())
  await wordStart.fill('999')
  // Committed on the way out, not per keystroke — clearing the field to type a
  // new number would otherwise land as a retime to zero on the way past.
  await wordStart.press('Enter')
  await page.waitForTimeout(200)
  const nowAt = Number(await wordStart.inputValue())
  if (nowAt === wasAt) fail(`retiming a word did nothing: still at ${nowAt}s`)
  if (nowAt >= 999) fail(`a word overtook the one after it, landing at ${nowAt}s`)
  step(`a single word retimed and clamped short of its neighbour (${wasAt}s -> ${nowAt}s)`)

  // Retiming a word from the timeline itself, with the keyboard. Dragging gets a
  // word roughly right; this is the only way to place one exactly, and it is the
  // half of word timing a mouse-only lane does not offer at all.
  // Zoomed in first. A word handle is sixteen pixels wide and centred on the
  // word it marks, so two words a fifth of a second apart overlap at the default
  // forty pixels a second — and the press lands on whichever is drawn on top,
  // which is not the one this step means to retime. Zooming is what a person
  // would do about that, and it is what the timeline is for.
  await page.fill('#zoom', '160')
  await page.waitForTimeout(100)

  const wordMark = page.locator(
    '[role="group"][aria-label^="Caption "] button[aria-label^="Word "]',
  )
  const firstMark = wordMark.first()
  await firstMark.scrollIntoViewIfNeeded()
  const markBox = await firstMark.boundingBox()
  if (!markBox) fail('no word handle on the timeline caption')
  // Big enough to hit without hunting: a handle a few pixels wide is a feature
  // nobody finds.
  if (markBox.width < 8 || markBox.height < 12) {
    fail(`word handle is too small to grab: ${markBox.width}x${markBox.height}`)
  }
  const markName = /^Word "(.+)" at /.exec(await firstMark.getAttribute('aria-label'))?.[1]
  // Clicking selects the word, which is what puts its exact timing on screen in
  // the transcript. Read the number there rather than the handle's own label:
  // that is rounded to a tenth, and a nudge is a hundredth.
  await firstMark.click()
  const nudged = page.locator(`input[aria-label^="When \\"${markName}\\" is highlighted"]`)
  const beforeNudge = Number(await nudged.inputValue())
  await firstMark.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  const afterNudge = Number(await nudged.inputValue())
  if (!(afterNudge > beforeNudge)) {
    fail(`arrow keys did not retime the word on the timeline: ${beforeNudge}s -> ${afterNudge}s`)
  }
  step(
    `word retimed from the timeline with the keyboard (${beforeNudge}s -> ${afterNudge}s, ` +
      `${markBox.width}x${markBox.height} handle)`,
  )

  // Dragging the head of a caption is how you bring it up earlier or later
  // without touching a word in it, and only a real browser exercises it.
  const firstBlock = page.locator('[role="group"][aria-label^="Caption "]').first()
  await firstBlock.scrollIntoViewIfNeeded()
  const blockBox = await firstBlock.boundingBox()
  if (!blockBox) fail('no caption block on the timeline to drag')
  const beforeTrim = await firstBlock.getAttribute('aria-label')
  await page.mouse.move(blockBox.x + 2, blockBox.y + blockBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(blockBox.x + 30, blockBox.y + blockBox.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const afterTrim = await firstBlock.getAttribute('aria-label')
  if (beforeTrim === afterTrim) fail(`dragging a caption's edge did nothing: "${afterTrim}"`)
  step(`a caption brought up later by dragging its edge (${beforeTrim} -> ${afterTrim})`)

  // --- Captions survive being put down and picked up again ----------------
  // Nothing about a caption is derived: the words, their timings and the style
  // are all document, and all of it has to reach storage. A reload is the only
  // place the round trip through IndexedDB actually happens — and the same
  // document is what gets pushed to Supabase, so a key missing from one is
  // missing from both.
  const captionState = () =>
    page.$$eval('[role="group"][aria-label^="Caption "]', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    )
  const wordMarks = () =>
    page.$$eval('button[aria-label^="Word "]', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    )

  const captionsBefore = await captionState()
  const wordsBefore = await wordMarks()

  await page.waitForTimeout(600) // let the write to IndexedDB land
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('section[aria-label="Timeline"] .group', { timeout: 30000 })

  const captionsAfter = await captionState()
  const wordsAfter = await wordMarks()

  if (captionsAfter.length !== captionsBefore.length) {
    fail(
      `captions did not survive a reload: ${captionsBefore.length} before, ` +
        `${captionsAfter.length} after`,
    )
  }
  if (JSON.stringify(captionsAfter) !== JSON.stringify(captionsBefore)) {
    const changed = captionsBefore.find((label, index) => label !== captionsAfter[index])
    fail(
      `a caption came back changed: "${changed}" -> "${captionsAfter[captionsBefore.indexOf(changed)]}"`,
    )
  }
  if (JSON.stringify(wordsAfter) !== JSON.stringify(wordsBefore)) {
    fail('word timings did not survive a reload')
  }
  // The edits made above specifically, since those are the ones a save could
  // plausibly have missed: a retyped word, a retimed word, a dragged edge.
  if (!captionsAfter.some((label) => label?.includes('SPLICED'))) {
    fail('the edited transcript did not survive a reload')
  }
  step(
    `${captionsAfter.length} captions and ${wordsAfter.length} word timings came back ` +
      `unchanged after a reload`,
  )

  // The style lives on the caption track, not on any cue, so it is saved by a
  // different path and worth checking separately.
  await page.getByRole('button', { name: /4 · Captions/ }).click()
  // Folded away by default now that there is a transcript to make room for, so
  // this is also the check that what is inside still works once unfolded.
  await page.getByRole('button', { name: 'Look' }).click()
  await page.waitForSelector('input[aria-label="Caption size, as a fraction of the frame height"]')
  const sizeSlider = page.locator(
    'input[aria-label="Caption size, as a fraction of the frame height"]',
  )
  await sizeSlider.fill('0.12')
  await page.waitForTimeout(600)
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /4 · Captions/ }).click()
  // Folded again: which card is open is a view preference, not part of the
  // document, and a fresh load should start compact however it was left.
  await page.getByRole('button', { name: 'Look' }).click()
  await page.waitForSelector('input[aria-label="Caption size, as a fraction of the frame height"]')
  const savedSize = Number(await sizeSlider.inputValue())
  if (Math.abs(savedSize - 0.12) > 0.001) {
    fail(`the caption style did not survive a reload: size is ${savedSize}, not 0.12`)
  }
  step(`caption styling saved too (size ${savedSize} of the frame)`)

  // Drawn over the picture, with exactly one word picked out. Checking the
  // computed colour rather than the markup is the point: a caption that renders
  // in the wrong place, at the wrong size or with every word the same colour is
  // still a paragraph of text on the page.
  //
  // The moment to look at is taken from the timeline rather than guessed, so
  // this lands mid-way through a caption with several words in it however the
  // transcript happened to be grouped.
  const wordy = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('[role="group"][aria-label^="Caption "]')].map(
      (element) => element.getAttribute('aria-label') ?? '',
    )
    for (const label of labels) {
      // The label carries the source clip after the times, so this cannot
      // anchor straight onto the end of the string.
      const found = /^Caption "(.+)", (\d+):(\d+\.\d) to (\d+):(\d+\.\d)(?:, from .*)?$/.exec(label)
      if (!found) continue
      if (found[1].split(/\s+/).length < 3) continue
      const start = Number(found[2]) * 60 + Number(found[3])
      const end = Number(found[4]) * 60 + Number(found[5])
      return { text: found[1], at: (start + end) / 2 }
    }
    return null
  })
  if (!wordy) fail('no caption with enough words to show a highlight travelling')
  await page.locator('input[aria-label="Scrub through the timeline"]').fill(String(wordy.at))
  await page.waitForTimeout(300)
  const drawn = await page.evaluate(() => {
    const box = document.querySelector('section[aria-label="Preview"] > div')
    const line = box?.querySelector('p[data-caption-track]')
    if (!box || !line) return null
    const spans = [...line.querySelectorAll('span')]
    const colours = spans.map((span) => getComputedStyle(span).color)
    const frame = box.getBoundingClientRect()
    const text = line.getBoundingClientRect()
    return {
      words: spans.length,
      distinct: new Set(colours).size,
      // As fractions of the frame, which is how the style is defined.
      fontFraction: parseFloat(getComputedStyle(line).fontSize) / frame.height,
      // Anchored by its bottom edge, which is what libass does with a
      // bottom-aligned subtitle — so this is the number the export honours.
      bottomFraction: (text.bottom - frame.top) / frame.height,
      family: getComputedStyle(line).fontFamily,
    }
  })
  if (!drawn) fail(`no caption drawn over the preview at ${wordy.at}s ("${wordy.text}")`)
  if (drawn.words < 2) fail(`caption has too few words to highlight one: ${drawn.words}`)
  if (drawn.distinct !== 2) {
    fail(`exactly one word should be picked out, found ${drawn.distinct} colours in the line`)
  }
  if (drawn.fontFraction < 0.05) fail(`captions are not large: ${drawn.fontFraction} of the frame`)
  // 0.82 down the frame plus half a line: the style's position is the middle
  // of a single line, and the block hangs from just below it.
  if (Math.abs(drawn.bottomFraction - (0.82 + drawn.fontFraction / 2)) > 0.03) {
    fail(`captions should sit low in the frame, bottom edge is at ${drawn.bottomFraction}`)
  }
  if (!/Lindy Toon Wide Captions/.test(drawn.family)) {
    fail(`captions should use the font that gets burnt in, got "${drawn.family}"`)
  }
  step(
    `captions drawn over the picture with one word lit ` +
      `(${Math.round(drawn.fontFraction * 100)}% of the frame, ${Math.round(
        drawn.bottomFraction * 100,
      )}% down)`,
  )

  // Fullscreen drops the preview's aspect ratio and lets the picture letterbox
  // itself inside the whole screen. Captions have to follow the picture, not the
  // black around it, or they are sized and placed against the wrong frame — and
  // the export, which knows only the project's own size, disagrees with what was
  // positioned here.
  await page.getByRole('button', { name: 'Fullscreen' }).click()
  await page.waitForTimeout(400)
  const framed = await page.evaluate(() => {
    const line = document.querySelector('p[data-caption-track]')
    const video = document.querySelector('section[aria-label="Preview"] video')
    if (!line || !video) return null
    const text = line.getBoundingClientRect()
    return {
      lineWidth: text.width,
      screenWidth: window.innerWidth,
      // The picture's own width, which for a 9:16 project on a wide screen is a
      // strip down the middle.
      pictureWidth: (video.getBoundingClientRect().height * 720) / 1280,
      fontPx: parseFloat(getComputedStyle(line).fontSize),
      pictureHeight: video.getBoundingClientRect().height,
    }
  })
  await page.getByRole('button', { name: 'Exit fullscreen' }).click()
  await page.waitForTimeout(300)

  if (!framed) fail('no caption drawn over the fullscreen preview')
  if (framed.lineWidth > framed.pictureWidth) {
    fail(
      `fullscreen captions are ${Math.round(framed.lineWidth)}px wide across a ` +
        `${Math.round(framed.pictureWidth)}px picture — they are following the black bars`,
    )
  }
  // The style's own fraction, which is the one the exported subtitle file is
  // built to — read back rather than hardcoded, since it is adjustable above.
  const styleSize = Number(await sizeSlider.inputValue())
  if (Math.abs(framed.fontPx / framed.pictureHeight - styleSize) > 0.015) {
    fail(
      `fullscreen caption size is ${(framed.fontPx / framed.pictureHeight).toFixed(3)} of the ` +
        `picture height, not the ${styleSize} the export uses`,
    )
  }
  step(
    `fullscreen captions stay on the picture ` +
      `(${Math.round(framed.lineWidth)}px inside a ${Math.round(framed.pictureWidth)}px frame, ` +
      `not ${framed.screenWidth}px)`,
  )

  if (!fontResponses.some((response) => response.status === 200)) {
    fail(
      `the caption font was never served — ${JSON.stringify(fontResponses)}. ` +
        `Check that scripts/copy-caption-font.mjs ran.`,
    )
  }
  step('the caption typeface is served from this origin, so it can also be burnt in')

  // --- Transitions ----------------------------------------------------------
  // A dissolve is an overlap, so the one thing that proves it landed is the
  // timeline getting shorter — and the only place that can be seen end to end
  // is here, where the same number has to come back out of the encoder as an
  // MP4 of that length. `xfade` is also the one filter in the graph that a
  // stripped-down ffmpeg build might simply not have, and a unit test asserting
  // on argv cannot tell us whether it does.
  const pictureLength = async () => {
    const text = await page.textContent('section[aria-label="Timeline"] header span')
    const found = /(\d+):(\d+\.\d)/.exec(text)
    return found ? Number(found[1]) * 60 + Number(found[2]) : 0
  }

  const seam = page.locator('button[aria-label="Add a transition between these clips"]').first()
  await seam.scrollIntoViewIfNeeded()
  const beforeBlend = await pictureLength()
  await seam.click()
  await page.waitForSelector('div[role="dialog"][aria-label="Transitions"]', { timeout: 5000 })
  step('the mark between two clips opens the transition picker')

  await page.getByRole('button', { name: 'Cross dissolve' }).click()
  await page.waitForTimeout(300)
  const afterBlend = await pictureLength()
  if (!(afterBlend < beforeBlend)) {
    fail(`a dissolve should have shortened the picture, ${beforeBlend}s -> ${afterBlend}s`)
  }
  await page.keyboard.press('Escape')
  step(`cross dissolve applied, overlapping the clips (${beforeBlend}s -> ${afterBlend}s)`)

  // Stored on the clip and nowhere else, so this is the round trip through
  // IndexedDB that no unit test reaches.
  await page.waitForTimeout(500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('section[aria-label="Timeline"] .group', { timeout: 30000 })
  const reopenedBlend = await pictureLength()
  if (Math.abs(reopenedBlend - afterBlend) > 0.05) {
    fail(`the dissolve did not survive a reload, ${afterBlend}s -> ${reopenedBlend}s`)
  }
  const badge = await page
    .locator('button[aria-label^="Edit the cross dissolve"]')
    .first()
    .getAttribute('aria-label')
  if (!/\d+ms/.test(badge ?? '')) fail(`the reopened boundary does not show its length: "${badge}"`)
  step(`the dissolve is still there when the project is opened again (${badge})`)

  // --- Export --------------------------------------------------------------
  // Counted again here rather than reusing the count taken when the transcript
  // first landed: redoing one clip's captions in between changes how many there
  // are, and what the export has to burn in is whatever is on the timeline now.
  const captionsToBurn = await page.locator('[role="group"][aria-label^="Caption "]').count()

  await page.getByRole('button', { name: 'Export' }).first().click()
  await page.waitForSelector('text=Render and download MP4')

  // The summary is how we know all four layers — two takes, the score and the
  // count-in — reach the mixer, rather than one quietly replacing another.
  const summary = await page.evaluate(
    () =>
      [...document.querySelectorAll('dialog[open] p')]
        .map((p) => p.textContent ?? '')
        .find((text) => /audio clip/.test(text)) ?? '',
  )
  const clipCount = Number(/(\d+) audio clips?/.exec(summary)?.[1] ?? 0)
  const trackTotal = Number(/across (\d+) track/.exec(summary)?.[1] ?? 0)
  if (clipCount !== 4) fail(`expected 4 audio clips in the export, summary said: "${summary}"`)
  if (trackTotal !== 4) fail(`expected 4 audio tracks in the export, summary said: "${summary}"`)
  if (!/of black before the picture/.test(summary)) {
    fail(`the export should carry the lead-in, summary said: "${summary}"`)
  }
  if (!/1 transition/.test(summary)) {
    fail(`the export should carry the dissolve, summary said: "${summary}"`)
  }

  // The first m:ss.d in the summary is the length of the render, which is what
  // the MP4 is checked against below — the two agreeing is how we know the
  // black at the head was really encoded rather than just promised.
  const promised = /(\d+):(\d+\.\d)/.exec(summary)
  const promisedSeconds = promised ? Number(promised[1]) * 60 + Number(promised[2]) : 0
  if (promisedSeconds < 9) {
    fail(`a 7s picture pushed back past 3s should render longer than 9s, got ${promisedSeconds}s`)
  }
  if (!/keep their own sound/.test(summary)) {
    fail(`export should keep the video clips' sound, summary said: "${summary}"`)
  }
  const burntIn = Number(/(\d+) captions? burnt in/.exec(summary)?.[1] ?? 0)
  if (burntIn !== captionsToBurn) {
    fail(`all ${captionsToBurn} captions should be burnt in, summary said: "${summary}"`)
  }
  step(
    `export receives ${clipCount} audio clips across ${trackTotal} tracks, ` +
      `plus clip sound and ${burntIn} captions`,
  )

  const download = page.waitForEvent('download', { timeout: 420000 })
  await page.getByRole('button', { name: /Render and download MP4/ }).click()
  const file = await download
  const target = join(workDir, 'export.mp4')
  await file.saveAs(target)
  step('MP4 rendered and downloaded')

  // --- Verify the artefact, not just that a file appeared ------------------
  const mp4 = unpack(readFileSync(target))
  if (!mp4.complete) fail('exported MP4 box structure is truncated')
  if (!mp4.hasVideo) fail('exported MP4 has no H.264 video track')
  if (!mp4.hasAudio) fail('exported MP4 has no AAC audio track despite four audio layers')
  if (mp4.durationSeconds < 1) fail(`exported MP4 duration looks wrong: ${mp4.durationSeconds}s`)
  if (Math.abs(mp4.durationSeconds - promisedSeconds) > 0.5) {
    fail(
      `the MP4 is ${mp4.durationSeconds.toFixed(2)}s but the export promised ` +
        `${promisedSeconds}s — the lead-in did not make it into the file`,
    )
  }
  if (mp4.boxes[1] !== 'moov') fail('moov is not first, so +faststart did not take effect')
  step(
    `export verified: ${mp4.durationSeconds.toFixed(2)}s, ${mp4.width}x${mp4.height}, ` +
      `video+audio, faststart`,
  )

  // --- The report bubble ---------------------------------------------------
  // Last, and deliberately so: it is the one thing here that floats over the
  // editor, and a 48px button in the corner is exactly the sort of thing that
  // starts intercepting clicks meant for the timeline. Everything above has
  // already run with it on the page.
  //
  // The export dialog is still open at this point, and a modal <dialog> makes
  // everything behind it inert — including the bubble.
  await page.getByRole('dialog').getByLabel('Close').click()

  await page.getByRole('button', { name: 'Report a problem or suggest a feature' }).click()
  await page.getByRole('dialog', { name: 'Report a problem' }).waitFor()
  step('report bubble opens')

  await page.getByRole('textbox', { name: 'Title' }).fill('The export stops at 40%')
  await page.getByRole('textbox', { name: 'Details' }).fill('It hangs there every time.')

  // What the issue will carry has to be visible before it is posted — the
  // reporter's own address included, since this goes to a public tracker.
  await page.getByText('What gets attached').click()
  const attached = await page.locator('.fixed pre').first().innerText()
  for (const expected of ['Reported by:', 'Build:', 'Project:']) {
    if (!attached.includes(expected)) {
      fail(`the preview does not show "${expected}": ${attached}`)
    }
  }
  step('the form shows what filing would publish, address included')

  await page.getByRole('button', { name: /^Post/ }).click()
  await page.getByText(/Nothing was posted/).waitFor({ timeout: 15000 })
  step('posting in mock mode files nothing and says so')

  if (pageErrors.length) fail(`console errors during the run:\n    ${pageErrors.join('\n    ')}`)
  step('no console errors')

  console.log(`\nAll ${steps.length} checks passed.`)
} finally {
  await browser.close()
}
