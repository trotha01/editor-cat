/**
 * Copies the ffmpeg.wasm single-threaded core out of node_modules and into
 * public/ffmpeg/ so the app can load it same-origin.
 *
 * Why self-host instead of using a CDN:
 *  - the Content-Security-Policy in netlify.toml only allows 'self' for scripts
 *  - a third-party CDN outage would break export
 *  - the core is ~30MB, so it stays out of git and is produced at build time
 *
 * We use the single-threaded core deliberately: the multithreaded one needs
 * SharedArrayBuffer, which requires COOP/COEP cross-origin isolation, which in
 * turn breaks loading any cross-origin resource in the page.
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'public', 'ffmpeg')

/*
 * The ESM build is required, not the UMD one.
 *
 * Vite bundles @ffmpeg/ffmpeg's worker as a module worker, and `importScripts`
 * does not exist inside one. The worker catches that and falls back to
 * `await import(coreURL)`, which needs a real ES module with a default export.
 * Handing it the UMD build makes `createFFmpegCore` come back undefined and
 * export fails with the unhelpful "failed to import ffmpeg-core.js".
 */
const candidates = [
  join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm'),
  join(root, 'node_modules', '@ffmpeg', 'core', 'dist'),
]

const src = candidates.find((p) => existsSync(p))

if (!src) {
  console.warn(
    '[copy-ffmpeg] @ffmpeg/core not found in node_modules. Export will be unavailable ' +
      'until dependencies are installed. Skipping.',
  )
  process.exit(0)
}

await mkdir(dest, { recursive: true })
await cp(src, dest, { recursive: true })

const copied = await readdir(dest)
console.log(`[copy-ffmpeg] copied ${copied.length} file(s) from ${src} -> public/ffmpeg`)
