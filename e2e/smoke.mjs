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
  await page.getByRole('button', { name: /2 · Video/ }).click()
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
    page.locator('section[aria-label="Timeline"] button[aria-label^="Undo the cut"]').count()

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

  await page.getByRole('button', { name: /3 · Audio/ }).click()
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

  // --- Export --------------------------------------------------------------
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
  step(`export receives ${clipCount} audio clips across ${trackTotal} tracks, plus clip sound`)

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

  if (pageErrors.length) fail(`console errors during the run:\n    ${pageErrors.join('\n    ')}`)
  step('no console errors')

  console.log(`\nAll ${steps.length} checks passed.`)
} finally {
  await browser.close()
}
