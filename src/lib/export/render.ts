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
import { buildExportPlan, type ExportAudioClip, type ExportClip } from './buildGraph'

export interface ExportAsset {
  /** Stable key used to name the file inside the ffmpeg filesystem. */
  id: string
  blob: Blob
  mimeType: string
}

export interface RenderRequest {
  clips: { assetId: string; kind: 'image' | 'video'; inPoint: number; duration: number }[]
  /** Already resolved to a track volume; muted tracks are dropped by the caller. */
  audio: { assetId: string; startTime: number; inPoint: number; duration: number; volume: number }[]
  assets: Map<string, ExportAsset>
  width: number
  height: number
  fps: number
  crf?: number
}

export type RenderPhase = 'loading' | 'writing' | 'encoding' | 'done'

export interface RenderProgress {
  phase: RenderPhase
  /** 0–1 within the encoding phase; undefined while loading or writing. */
  ratio?: number
  message: string
}

export interface RenderResult {
  blob: Blob
  /** ffmpeg's log output, kept so failures can be reported with real detail. */
  log: string[]
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
  const fileNameFor = new Map<string, string>()

  const stage = async (assetId: string, kind: 'image' | 'video' | 'audio') => {
    if (fileNameFor.has(assetId)) return
    const asset = request.assets.get(assetId)
    if (!asset) throw new Error(`Missing media for one of the clips (${assetId}).`)
    const name = `${assetId.replace(/[^a-zA-Z0-9_-]/g, '')}.${extensionFor(asset.mimeType, kind)}`
    await ffmpeg.writeFile(name, await fetchFile(asset.blob))
    written.add(name)
    fileNameFor.set(assetId, name)
  }

  for (const clip of request.clips) await stage(clip.assetId, clip.kind)
  for (const clip of request.audio) await stage(clip.assetId, 'audio')

  const outputFile = 'editor-cat-export.mp4'

  const exportClips: ExportClip[] = request.clips.map((clip) => ({
    file: fileNameFor.get(clip.assetId) as string,
    kind: clip.kind,
    inPoint: clip.inPoint,
    duration: clip.duration,
  }))

  const exportAudio: ExportAudioClip[] = request.audio.map((clip) => ({
    file: fileNameFor.get(clip.assetId) as string,
    startTime: clip.startTime,
    inPoint: clip.inPoint,
    duration: clip.duration,
    volume: clip.volume,
  }))

  const plan = buildExportPlan({
    clips: exportClips,
    audio: exportAudio,
    width: request.width,
    height: request.height,
    fps: request.fps,
    outputFile,
    ...(request.crf !== undefined ? { crf: request.crf } : {}),
  })

  // --- Encode ------------------------------------------------------------
  const onFfmpegProgress = ({ progress }: { progress: number }) => {
    onProgress?.({
      phase: 'encoding',
      ratio: Math.max(0, Math.min(1, progress)),
      message: `Rendering ${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`,
    })
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
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    // Copy into a fresh buffer: the wasm heap this view points at is reused.
    const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' })

    onProgress?.({ phase: 'done', ratio: 1, message: 'Done' })
    return { blob, log }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (ffmpegSingleton) {
      ffmpegSingleton.off('progress', onFfmpegProgress)
      // Free the staged inputs so a long session does not exhaust wasm memory.
      await Promise.all(
        [...written, outputFile].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)),
      )
    }
  }
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
