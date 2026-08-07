/**
 * Copies the in-browser speech recogniser into public/speech/.
 *
 * Two things go in there: transformers.js, which runs Whisper, and the ONNX
 * Runtime WebAssembly builds it executes the model with. Both are fetched from a
 * CDN by default, which this site's Content-Security-Policy refuses — and a
 * third-party CDN outage should not be able to break a feature either.
 *
 * Self-hosted *and* loaded at runtime rather than bundled, exactly like the
 * ffmpeg core, for the same two reasons:
 *
 *  - a visitor who never captions in the browser should not download half a
 *    megabyte of machine-learning runtime with the app;
 *  - transformers.js picks its own ONNX build at runtime, per browser. Bundling
 *    it means a bundler has to guess which one, and Vite's guess was to inline a
 *    23MB WebAssembly file into the output that nothing would ever load. Given
 *    the whole directory, the library's own choice applies unchanged.
 *
 * Kept out of git and produced at build time.
 *
 * `onnxruntime-web` is read through @huggingface/transformers rather than
 * declared here, because transformers pins an exact build of it and a second
 * declaration could only disagree. That is also why this is a devDependency: the
 * package brings Node bindings and an image library with it, none of which the
 * browser wants, and only these five files ever ship.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'public', 'speech')

/*
 * `transformers.min.js` specifically. It is the only build in the package with
 * no bare import specifiers left in it — the `.web.` builds still say
 * `from "onnxruntime-web/webgpu"`, which a browser cannot resolve and which is
 * the bundler's job to rewrite. This one has the runtime inlined and loads from
 * a URL as it stands.
 *
 * All four ONNX builds, because which one is used is the library's decision and
 * it varies by browser — Safari takes the plain pair, everything else the
 * asyncify pair. Handing over the directory rather than a filename is what keeps
 * that decision where it belongs.
 */
const FILES = [
  ['@huggingface/transformers/dist/transformers.min.js', 'transformers.js'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  [
    'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.mjs',
  ],
  [
    'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ],
]

const missing = FILES.filter(([from]) => !existsSync(join(root, 'node_modules', from)))
if (missing.length > 0) {
  console.warn(
    '[copy-speech-runtime] @huggingface/transformers not fully present in node_modules. ' +
      'Captioning in the browser will be unavailable; the ElevenLabs path is unaffected. Skipping.',
  )
  process.exit(0)
}

await mkdir(dest, { recursive: true })
for (const [from, to] of FILES) {
  await copyFile(join(root, 'node_modules', from), join(dest, to))
}

console.log(`[copy-speech-runtime] copied ${FILES.length} file(s) -> public/speech`)
