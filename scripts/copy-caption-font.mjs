/**
 * Copies the caption typeface out of assets/fonts/ and into public/fonts/.
 *
 * Burnt-in captions are drawn by libass inside ffmpeg.wasm, and that runs
 * against a virtual filesystem with no system fonts in it at all — asked to
 * render without one it logs "can't find selected font provider" and quietly
 * draws nothing. So the font has to be a file we can hand it, which means it has
 * to be a file we ship.
 *
 * The same file backs the preview overlay through an @font-face rule, which is
 * the point of shipping it rather than picking something off the user's machine:
 * what you position on the canvas is drawn with the very bytes that end up in
 * the MP4.
 *
 * TrueType specifically. FreeType inside this ffmpeg build reads TTF and OTF; it
 * does not read WOFF2, which is what most web font distributions ship.
 *
 * public/ is generated and kept out of git, like the ffmpeg core — the typeface
 * itself is checked in under assets/, and this stages it where both the dev
 * server and the build can serve it.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'public', 'fonts')
const source = join(root, 'assets', 'fonts')

/*
 * One face, because the family ships one: Lindy Toon Wide has a single Regular
 * weight, and a caption styled bold is this same face emboldened — by the
 * browser in the preview, by libass in the export. A real bold face, if one ever
 * arrives, is another entry here plus an @font-face rule; libass picks the face
 * out of this directory by family and weight on its own.
 *
 * The filename is ours to choose: libass reads the family name out of the file
 * itself, and the browser is told what is what by the @font-face rule.
 */
const FACES = [['LindyToonWide-Regular.ttf', 'LindyToonWide-Regular.ttf']]

if (!existsSync(source)) {
  console.warn(
    `[copy-caption-font] no font source at ${source}. Captions will fall back to a system font ` +
      'on screen and cannot be burnt into an export. Skipping.',
  )
  process.exit(0)
}

await mkdir(dest, { recursive: true })
for (const [from, to] of FACES) {
  await copyFile(join(source, from), join(dest, to))
}

console.log(`[copy-caption-font] copied ${FACES.length} font file(s) -> public/fonts`)
