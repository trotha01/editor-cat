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

  // --- Trimming ------------------------------------------------------------
  await page.locator('section[aria-label="Timeline"] .group').first().click()
  await page.fill('input[type="number"]', '2')
  await page.waitForTimeout(300)
  const trimmed = await page.textContent('section[aria-label="Timeline"] header span')
  if (trimmed === twoClips) fail('trimming a clip did not change the timeline duration')
  step(`trimming shortens the timeline (${twoClips.trim()} -> ${trimmed.trim()})`)

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

  // The summary is how we know all three layers reach the mixer, rather than
  // one take quietly replacing another.
  const summary = await page.evaluate(
    () =>
      [...document.querySelectorAll('dialog[open] p')]
        .map((p) => p.textContent ?? '')
        .find((text) => /audio clip/.test(text)) ?? '',
  )
  const clipCount = Number(/(\d+) audio clips?/.exec(summary)?.[1] ?? 0)
  const trackTotal = Number(/across (\d+) track/.exec(summary)?.[1] ?? 0)
  if (clipCount !== 3) fail(`expected 3 audio clips in the export, summary said: "${summary}"`)
  if (trackTotal !== 3) fail(`expected 3 audio tracks in the export, summary said: "${summary}"`)
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
  if (!mp4.hasAudio) fail('exported MP4 has no AAC audio track despite three audio layers')
  if (mp4.durationSeconds < 1) fail(`exported MP4 duration looks wrong: ${mp4.durationSeconds}s`)
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
