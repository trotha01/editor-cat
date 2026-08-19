/**
 * Runs an export with ffmpeg.wasm, entirely in the browser.
 *
 * Nothing is uploaded: the media never leaves the machine, which matters given
 * the user just paid a provider to generate it and may not want it passing
 * through a third party again.
 *
 * We use the single-threaded core on purpose. The multithreaded build needs
 * SharedArrayBuffer, which requires cross-origin isolation (COOP/COEP), which
 * would then block loading any cross-origin resource in the page. Slower
 * exports are a better trade than a site that cannot load provider media.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import {
  buildExportPlan,
  type ExportAudioClip,
  type ExportClip,
  type ExportOverlayClip,
} from './buildGraph'
import { hasAudioStream } from './probe'
import {
  HLS_SEGMENT_SECONDS,
  PLAYLIST_NAME,
  POSTER_NAME,
  buildHlsArgs,
  buildPosterArgs,
  contentTypeFor,
  initUri,
  normalizePlaylistUris,
  segmentUris,
} from './hlsArgs'
import type { ExportRange } from './range'
import { xfadeNameOf } from '../transitions'
import type { Transition } from '../types'

export interface ExportAsset {
  /** Stable key used to name the file inside the ffmpeg filesystem. */
  id: string
  blob: Blob
  mimeType: string
}

export interface RenderRequest {
  clips: {
    assetId: string
    kind: 'image' | 'video'
    inPoint: number
    duration: number
    /**
     * How this clip comes in from the one before it, already fitted to what the
     * two of them can afford — pass what `layoutClips` resolved rather than what
     * the clip stores.
     */
    transition?: Transition | null
    /** Gain for the clip's own sound. Absent is unity; 0 leaves it out. */
    volume?: number
  }[]
  /**
   * Picture layered over the clips, bottom of the stack first. Already resolved
   * to a lane opacity; hidden lanes are dropped by the caller.
   */
  overlays?: {
    assetId: string
    kind: 'image' | 'video'
    startTime: number
    inPoint: number
    duration: number
    opacity: number
    /** Gain for the layer's own sound. Absent is unity; 0 leaves it out. */
    volume?: number
  }[]
  /** Already resolved to a track volume; muted tracks are dropped by the caller. */
  audio: { assetId: string; startTime: number; inPoint: number; duration: number; volume: number }[]
  assets: Map<string, ExportAsset>
  width: number
  height: number
  fps: number
  /** Seconds of black before the first clip. Audio keeps its own timing. */
  leadIn?: number
  /**
   * Captions to burn in, as a ready-made ASS file plus the font faces it needs.
   * Absent means no captions and no font is fetched at all.
   */
  captions?: { ass: string; fonts: readonly CaptionFont[] }
  /** The stretch of the timeline to keep. Absent is all of it. */
  range?: ExportRange
  /**
   * Render the mix on its own, as an M4A, with no picture encoded at all.
   *
   * The same sound as the video would carry — see `audioOnly` in buildGraph —
   * so this changes what comes out of the encoder rather than what goes into it.
   */
  audioOnly?: boolean
  crf?: number
  /**
   * Also package the finished MP4 as HLS, in this same ffmpeg session.
   *
   * Done here rather than as a second call for two reasons, both of which bite
   * silently. The `finally` below deletes the output, so a later pass would
   * have to write the whole MP4 back in — and ffmpeg.wasm's filesystem is
   * heap-backed with an allocator that never returns memory, so re-staging
   * sixty megabytes into a heap that just held the inputs *and* the output, in
   * a 32-bit address space, is a genuine out-of-memory in a long session. It
   * surfaces as a non-zero exit code with an unhelpful log.
   *
   * Absent means no packaging and no keyframe forcing, so a download-destined
   * export produces exactly the argv and exactly the file it always did.
   */
  hls?: { segmentSeconds?: number }
}

/** One font face for libass, named as it should appear on disk. */
export interface CaptionFont {
  fileName: string
  bytes: Uint8Array
}

/** Where the ASS file and the fonts are put inside ffmpeg's filesystem. */
const CAPTIONS_FILE = 'captions.ass'
const FONTS_DIR = '/fonts'

/**
 * Where the HLS package is written.
 *
 * Named twice on purpose: ffmpeg is given the *relative* form, because the
 * segment URIs it writes into the playlist are derived from the path it was
 * handed, and an absolute one can produce an absolute URI that resolves against
 * the CDN root. Reads and cleanup use the absolute form, since the working
 * directory is `/`.
 */
const HLS_DIR_NAME = 'hls'
const HLS_DIR = `/${HLS_DIR_NAME}`

export type RenderPhase = 'loading' | 'writing' | 'encoding' | 'packaging' | 'done'

export interface RenderProgress {
  phase: RenderPhase
  /** 0–1 within the encoding phase; undefined while loading or writing. */
  ratio?: number
  message: string
}

/** One file of an HLS package, ready to be uploaded as-is. */
export interface HlsFile {
  /** A bare name. Playlists reference their segments relative to themselves. */
  name: string
  blob: Blob
  contentType: string
}

export interface HlsPackage {
  /** The playlist text, after its URIs have been checked and normalised. */
  playlist: string
  /**
   * Everything to upload, playlist included. Ordered segments first and the
   * playlist last, which is the order it must be *uploaded* in: a playlist that
   * exists has to imply its segments exist, or a feed card spins forever.
   */
  files: HlsFile[]
}

export interface RenderResult {
  blob: Blob
  /** ffmpeg's log output, kept so failures can be reported with real detail. */
  log: string[]
  /** Present only when `hls` was requested. */
  hls?: HlsPackage
  /** The first frame as a JPEG, alongside an HLS package. */
  poster?: Blob
}

let ffmpegSingleton: FFmpeg | null = null

/**
 * Loads the core once and keeps it. It is ~30MB of wasm, so a second export
 * should not pay for it again.
 */
async function getFFmpeg(onLog: (line: string) => void): Promise<FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton

  const instance = new FFmpeg()
  instance.on('log', ({ message }) => onLog(message))

  await instance.load({
    // Served from our own origin by scripts/copy-ffmpeg.mjs — the CSP does not
    // permit third-party scripts, and a CDN outage should not break export.
    coreURL: '/ffmpeg/ffmpeg-core.js',
    wasmURL: '/ffmpeg/ffmpeg-core.wasm',
  })

  ffmpegSingleton = instance
  return instance
}

function extensionFor(mimeType: string, kind: 'image' | 'video' | 'audio'): string {
  const type = mimeType.toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('webm')) return 'webm'
  if (type.includes('quicktime')) return 'mov'
  if (type.includes('mp4')) return 'mp4'
  if (type.includes('mpeg')) return 'mp3'
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('wav')) return 'wav'
  if (kind === 'image') return 'png'
  if (kind === 'video') return 'mp4'
  return 'mp3'
}

export interface RenderOptions {
  onProgress?: (progress: RenderProgress) => void
  signal?: AbortSignal
}

/** Renders the timeline to an MP4. */
export async function renderProject(
  request: RenderRequest,
  { onProgress, signal }: RenderOptions = {},
): Promise<RenderResult> {
  const log: string[] = []
  const pushLog = (line: string) => {
    log.push(line)
    // ffmpeg is chatty; keeping the tail is enough to diagnose a failure.
    if (log.length > 400) log.splice(0, log.length - 400)
  }

  onProgress?.({ phase: 'loading', message: 'Loading the video encoder…' })
  const ffmpeg = await getFFmpeg(pushLog)

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  onProgress?.({ phase: 'writing', message: 'Preparing your media…' })

  // --- Stage every input into the virtual filesystem ---------------------
  const written = new Set<string>()
  // Directories are freed after their contents, in the same `finally`.
  const dirs: string[] = []
  const fileNameFor = new Map<string, string>()
  const segmentSeconds = request.hls?.segmentSeconds ?? HLS_SEGMENT_SECONDS
  const audioOnly = request.audioOnly === true

  const stage = async (assetId: string, kind: 'image' | 'video' | 'audio') => {
    if (fileNameFor.has(assetId)) return
    const asset = request.assets.get(assetId)
    if (!asset) throw new Error(`Missing media for one of the clips (${assetId}).`)
    const name = `${assetId.replace(/[^a-zA-Z0-9_-]/g, '')}.${extensionFor(asset.mimeType, kind)}`
    await ffmpeg.writeFile(name, await fetchFile(asset.blob))
    written.add(name)
    fileNameFor.set(assetId, name)
  }

  // A render with no picture in it stages no pictures. Only a video clip that
  // has not been silenced can put anything into a soundtrack, and writing the
  // rest into the encoder's filesystem would spend memory — which in a 32-bit
  // heap that never gives any back is the scarce thing — to produce nothing.
  const mayBeHeard = (clip: { kind: 'image' | 'video'; volume?: number }) =>
    !audioOnly || (clip.kind === 'video' && (clip.volume ?? 1) > 0)

  for (const clip of request.clips) {
    if (mayBeHeard(clip)) await stage(clip.assetId, clip.kind)
  }
  for (const clip of request.overlays ?? []) {
    if (mayBeHeard(clip)) await stage(clip.assetId, clip.kind)
  }
  for (const clip of request.audio) await stage(clip.assetId, 'audio')

  // --- Captions ----------------------------------------------------------
  // The subtitle file and the fonts it names both have to exist before the
  // filtergraph references them. libass without a font it can load draws
  // nothing and does not fail, so the fonts are as load-bearing as the cues.
  if (request.captions) {
    await ffmpeg.writeFile(CAPTIONS_FILE, new TextEncoder().encode(request.captions.ass))
    written.add(CAPTIONS_FILE)
    await ffmpeg.createDir(FONTS_DIR).catch(() => undefined)
    dirs.push(FONTS_DIR)
    for (const font of request.captions.fonts) {
      const path = `${FONTS_DIR}/${font.fileName}`
      await ffmpeg.writeFile(path, font.bytes)
      written.add(path)
    }
  }

  const outputFile = audioOnly ? 'editor-cat-export.m4a' : 'editor-cat-export.mp4'
  // There is no streaming package to make of a bare soundtrack — a feed card
  // plays a video — so an audio-only render ignores the request rather than
  // packaging something nothing can play, and skips the keyframes that only
  // exist for a segmenter to cut on.
  const packaging = request.hls !== undefined && !audioOnly

  // --- Find out which clips have sound of their own ----------------------
  // Only the files whose sound would actually be used are probed: a muted clip
  // or a still cannot contribute one either way.
  const soundIn = new Map<string, boolean>()
  const candidates = [...request.clips, ...(request.overlays ?? [])].filter(
    (clip) => clip.kind === 'video' && (clip.volume ?? 1) > 0,
  )
  if (candidates.length > 0) {
    onProgress?.({ phase: 'writing', message: 'Checking your clips for sound…' })
    for (const clip of candidates) {
      const file = fileNameFor.get(clip.assetId) as string
      if (soundIn.has(file)) continue
      soundIn.set(file, await hasAudioStream(ffmpeg, file))
    }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const exportClips: ExportClip[] = request.clips.map((clip) => {
    // Empty for a clip an audio-only render never staged. It still has to be in
    // this list — the clips are what say where each one sits on the timeline,
    // which is where the sound of its neighbours goes — but `hasAudio: false`
    // then keeps it out of the graph, so the name is never asked for.
    const file = fileNameFor.get(clip.assetId) ?? ''
    return {
      file,
      kind: clip.kind,
      inPoint: clip.inPoint,
      duration: clip.duration,
      // Translated to ffmpeg's vocabulary here, at the edge, so the graph
      // builder never has to know what this app calls its transitions.
      ...(clip.transition
        ? {
            transition: {
              name: xfadeNameOf(clip.transition.kind),
              duration: clip.transition.duration,
            },
          }
        : {}),
      hasAudio: soundIn.get(file) ?? false,
      volume: clip.volume ?? 1,
    }
  })

  const exportOverlays: ExportOverlayClip[] = (request.overlays ?? []).map((clip) => {
    // Empty for the same reason a clip's can be — see above.
    const file = fileNameFor.get(clip.assetId) ?? ''
    return {
      file,
      kind: clip.kind,
      startTime: clip.startTime,
      inPoint: clip.inPoint,
      duration: clip.duration,
      opacity: clip.opacity,
      hasAudio: soundIn.get(file) ?? false,
      volume: clip.volume ?? 1,
    }
  })

  const exportAudio: ExportAudioClip[] = request.audio.map((clip) => ({
    file: fileNameFor.get(clip.assetId) as string,
    startTime: clip.startTime,
    inPoint: clip.inPoint,
    duration: clip.duration,
    volume: clip.volume,
  }))

  const plan = buildExportPlan({
    clips: exportClips,
    overlays: exportOverlays,
    audio: exportAudio,
    width: request.width,
    height: request.height,
    fps: request.fps,
    outputFile,
    ...(request.leadIn ? { leadIn: request.leadIn } : {}),
    ...(request.captions ? { captions: { file: CAPTIONS_FILE, fontsDir: FONTS_DIR } } : {}),
    ...(request.range ? { range: request.range } : {}),
    ...(audioOnly ? { audioOnly } : {}),
    ...(request.crf !== undefined ? { crf: request.crf } : {}),
    ...(packaging ? { keyframeSeconds: segmentSeconds } : {}),
  })

  // --- Encode ------------------------------------------------------------
  // One handler for both passes rather than swapping it out, so the single
  // `off()` in `finally` stays correct. The phase is read at call time; the
  // packaging pass reports its own progress rather than sending the bar back
  // to zero and walking it up again.
  let phase: RenderPhase = 'encoding'
  const onFfmpegProgress = ({ progress }: { progress: number }) => {
    const ratio = Math.max(0, Math.min(1, progress))
    onProgress?.(
      phase === 'encoding'
        ? { phase, ratio, message: `Rendering ${Math.round(ratio * 100)}%` }
        : { phase, ratio, message: 'Packaging for streaming…' },
    )
  }
  ffmpeg.on('progress', onFfmpegProgress)

  const onAbort = () => {
    // Terminating is the only way to interrupt a running ffmpeg call. The
    // instance is unusable afterwards, so drop it and rebuild on next export.
    try {
      ffmpeg.terminate()
    } finally {
      ffmpegSingleton = null
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    onProgress?.({ phase: 'encoding', ratio: 0, message: 'Rendering 0%' })
    const code = await ffmpeg.exec(plan.args)
    if (code !== 0) {
      throw new Error(
        `The encoder exited with code ${code}. Last output:\n${log.slice(-12).join('\n')}`,
      )
    }

    const data = await ffmpeg.readFile(outputFile)
    const bytes = bytesOf(data)
    // Copy into a fresh buffer: the wasm heap this view points at is reused.
    const blob = new Blob([new Uint8Array(bytes)], {
      type: audioOnly ? 'audio/mp4' : 'video/mp4',
    })

    if (!packaging) {
      onProgress?.({ phase: 'done', ratio: 1, message: 'Done' })
      return { blob, log }
    }

    phase = 'packaging'
    onProgress?.({ phase, ratio: 0, message: 'Packaging for streaming…' })

    const packaged = await packageHls(ffmpeg, outputFile, segmentSeconds, written, dirs, log)
    const poster = await extractPoster(ffmpeg, outputFile, written, log)

    onProgress?.({ phase: 'done', ratio: 1, message: 'Done' })
    return { blob, log, hls: packaged, ...(poster ? { poster } : {}) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (ffmpegSingleton) {
      ffmpegSingleton.off('progress', onFfmpegProgress)
      // Free the staged inputs so a long session does not exhaust wasm memory.
      await Promise.all(
        [...written, outputFile].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)),
      )
      // Directories go after their contents, and this is also where the fonts
      // directory finally gets freed — it was leaked before this existed.
      for (const dir of dirs) {
        await ffmpeg.deleteDir(dir).catch(() => undefined)
      }
    }
  }
}

/**
 * Runs the packaging pass and reads its output back out.
 *
 * Every name it produces is added to `written` as it is found, so the caller's
 * existing `finally` frees them and there is no second cleanup path to keep in
 * step with the first.
 */
async function packageHls(
  ffmpeg: FFmpeg,
  input: string,
  segmentSeconds: number,
  written: Set<string>,
  dirs: string[],
  log: string[],
): Promise<HlsPackage> {
  // Swept *before* the pass, not only after. The cleanup in `finally` is
  // best-effort — every delete is wrapped in a catch — so a run that failed
  // partway can leave segments behind, and segments are discovered by listing
  // the directory. A stale one would be swept into the next publication, which
  // is somebody else's frames in your video.
  await sweep(ffmpeg, HLS_DIR)
  await ffmpeg.createDir(HLS_DIR).catch(() => undefined)
  dirs.push(HLS_DIR)

  const code = await ffmpeg.exec(buildHlsArgs({ input, dir: HLS_DIR_NAME, segmentSeconds }))
  if (code !== 0) {
    throw new Error(
      `Packaging for streaming exited with code ${code}. Last output:\n${log.slice(-12).join('\n')}`,
    )
  }

  const read = async (name: string): Promise<Uint8Array> => {
    const data = await ffmpeg.readFile(`${HLS_DIR}/${name}`)
    written.add(`${HLS_DIR}/${name}`)
    return bytesOf(data)
  }

  const raw = new TextDecoder().decode(await read(PLAYLIST_NAME))
  // Belt and braces over asking ffmpeg for relative paths: an absolute URI here
  // resolves against the CDN root, which 404s in production and works locally.
  const playlist = normalizePlaylistUris(raw)

  const names = segmentUris(playlist)
  if (names.length === 0) {
    throw new Error('Packaging for streaming produced a playlist with no segments.')
  }

  const files: HlsFile[] = []

  // Segments first, then the init segment, and the playlist last. This is the
  // order they must be uploaded in — see HlsPackage.
  for (const name of names) {
    files.push({
      name,
      blob: blobOf(await read(name), contentTypeFor(name)),
      contentType: contentTypeFor(name),
    })
  }

  const init = initUri(playlist)
  if (init) {
    files.push({
      name: init,
      blob: blobOf(await read(init), contentTypeFor(init)),
      contentType: contentTypeFor(init),
    })
  }

  files.push({
    name: PLAYLIST_NAME,
    blob: new Blob([playlist], { type: contentTypeFor(PLAYLIST_NAME) }),
    contentType: contentTypeFor(PLAYLIST_NAME),
  })

  return { playlist, files }
}

/**
 * The first frame, as a JPEG.
 *
 * Worth having because dropping the progressive MP4 costs the feed its first
 * paint: `preload="metadata"` no longer draws a frame while the manifest is
 * still being fetched. The file is already in the filesystem and the encoder is
 * already loaded, so this is close to free.
 *
 * A failure is not fatal — the feed falls back to its own first decoded frame,
 * which is what it does today — so this returns null rather than throwing.
 */
async function extractPoster(
  ffmpeg: FFmpeg,
  input: string,
  written: Set<string>,
  log: string[],
): Promise<Blob | null> {
  try {
    await ffmpeg.deleteFile(POSTER_NAME).catch(() => undefined)
    const code = await ffmpeg.exec(buildPosterArgs(input, POSTER_NAME))
    if (code !== 0) {
      log.push(`[poster] ffmpeg exited with code ${code}; publishing without one.`)
      return null
    }
    written.add(POSTER_NAME)
    const data = await ffmpeg.readFile(POSTER_NAME)
    const bytes = bytesOf(data)
    return blobOf(bytes, contentTypeFor(POSTER_NAME))
  } catch (error) {
    log.push(`[poster] ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * ffmpeg's `readFile` answers `Uint8Array | string`, and this discriminates on
 * the string rather than on `instanceof Uint8Array`.
 *
 * Not a style preference. `instanceof` compares against one realm's
 * constructor, so a typed array that arrived from another — a worker, a test
 * environment, anything with its own globals — fails the check and falls
 * through to `String(data)`, which stringifies a byte array as "35,69,88,…".
 * That is not an error anywhere: it is a perfectly valid string that happens to
 * be nonsense, and it would reach a playlist parser before anybody noticed.
 */
function bytesOf(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return data as Uint8Array
}

/** Copies out of the wasm heap, which is reused under us. */
function blobOf(bytes: Uint8Array, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type })
}

/** Removes a directory and everything in it, ignoring the parts that are absent. */
async function sweep(ffmpeg: FFmpeg, dir: string): Promise<void> {
  let entries: { name: string; isDir: boolean }[]
  try {
    entries = await ffmpeg.listDir(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isDir) continue
    await ffmpeg.deleteFile(`${dir}/${entry.name}`).catch(() => undefined)
  }
  await ffmpeg.deleteDir(dir).catch(() => undefined)
}

/** Frees the loaded core. Used when the export dialog closes for good. */
export function disposeRenderer(): void {
  if (!ffmpegSingleton) return
  try {
    ffmpegSingleton.terminate()
  } finally {
    ffmpegSingleton = null
  }
}
