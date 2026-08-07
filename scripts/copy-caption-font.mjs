/**
 * Copies the caption typeface out of node_modules and into public/fonts/.
 *
 * Burnt-in captions are drawn by libass inside ffmpeg.wasm, and that runs
 * against a virtual filesystem with no system fonts in it at all — asked to
 * render without one it logs "can't find selected font provider" and quietly
 * draws nothing. So the font has to be a file we can hand it, which means it has
 * to be a file we ship.
 *
 * The same files back the preview overlay through an @font-face rule, which is
 * the point of shipping them rather than picking something off the user's
 * machine: what you position on the canvas is drawn with the very bytes that
 * end up in the MP4.
 *
 * TrueType specifically. FreeType inside this ffmpeg build reads TTF and OTF;
 * it does not read WOFF2, which is all the usual web font packages ship — hence
 * @expo-google-fonts, which is an odd-looking dependency for a Vite app but is
 * the maintained npm distribution of the Google Fonts originals. Nothing at
 * runtime imports it, and it pulls in no dependencies of its own.
 *
 * Kept out of git like the ffmpeg core, and produced at build time.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'public', 'fonts')
const source = join(root, 'node_modules', '@expo-google-fonts', 'inter')

/*
 * Both weights, because the caption style offers both and the two have to agree:
 * libass picks the face out of this directory by family and weight, so a style
 * set to regular with only the bold face present would render bold in the export
 * and regular in the preview.
 *
 * The filenames are ours to choose: libass reads the family name out of the file
 * itself, and the browser is told which is which by the @font-face rules.
 */
const FACES = [
  ['400Regular/Inter_400Regular.ttf', 'Inter-Regular.ttf'],
  ['700Bold/Inter_700Bold.ttf', 'Inter-Bold.ttf'],
]

if (!existsSync(source)) {
  console.warn(
    '[copy-caption-font] @expo-google-fonts/inter not found in node_modules. Captions will ' +
      'fall back to a system font on screen and cannot be burnt into an export. Skipping.',
  )
  process.exit(0)
}

await mkdir(dest, { recursive: true })
for (const [from, to] of FACES) {
  await copyFile(join(source, from), join(dest, to))
}

console.log(`[copy-caption-font] copied ${FACES.length} font file(s) -> public/fonts`)
