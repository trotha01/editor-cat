/**
 * Getting provider media into our own storage, and reading its metadata.
 *
 * "Ingest on arrival": the moment something is generated we pull the bytes
 * into IndexedDB and work from blob: URLs from then on. That buys three
 * things — the project survives a refresh, editing works offline, and nothing
 * is read cross-origin during export (a tainted canvas would break MP4 output
 * in a way that is very hard to diagnose after the fact).
 */
import { putAsset, putBlob } from './db'
import type { Asset, AssetKind } from './types'

/** Above this, we re-encode stills to JPEG before sending them to a model. */
const DATA_URL_REENCODE_THRESHOLD = 2 * 1024 * 1024

export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${prefix}_${random}`
}

/**
 * Fetches media bytes, preferring a direct browser request and falling back to
 * our own proxy.
 *
 * Direct is tried first because it is free and has no size ceiling; the proxy
 * exists for providers whose CDN does not send CORS headers, and it is capped
 * by Netlify's response limits.
 */
export async function fetchMediaBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  // blob: and data: URLs are already local (mock mode produces these).
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const response = await fetch(url, { signal })
    return await response.blob()
  }

  try {
    const direct = await fetch(url, { mode: 'cors', signal })
    if (direct.ok) return await direct.blob()
  } catch {
    // CORS refusal or network error — fall through to the proxy.
  }

  const proxied = await fetch(`/api/media?url=${encodeURIComponent(url)}`, { signal })
  if (!proxied.ok) {
    let reason = `${proxied.status}`
    try {
      const body = (await proxied.json()) as { error?: string }
      if (body.error) reason = body.error
    } catch {
      /* keep the status code */
    }
    throw new Error(`Could not download the generated media: ${reason}`)
  }
  return await proxied.blob()
}

/** Reads duration and dimensions by letting the browser decode the media. */
export async function probeMedia(
  blob: Blob,
  kind: AssetKind,
): Promise<{ duration?: number; width?: number; height?: number }> {
  const url = URL.createObjectURL(blob)
  // Declared out here so the finally block can always detach it, whichever
  // branch we leave through.
  let element: HTMLMediaElement | null = null

  try {
    if (kind === 'image') {
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
        img.onerror = () => reject(new Error('That image could not be decoded.'))
        img.src = url
      })
      return size
    }

    element = document.createElement(kind === 'video' ? 'video' : 'audio')
    element.preload = 'metadata'

    const media = element
    const metadata = await new Promise<{ duration: number; width?: number; height?: number }>(
      (resolve, reject) => {
        media.onloadedmetadata = () => {
          const video = media as HTMLVideoElement
          resolve({
            duration: media.duration,
            width: kind === 'video' ? video.videoWidth : undefined,
            height: kind === 'video' ? video.videoHeight : undefined,
          })
        }
        media.onerror = () => reject(new Error(`That ${kind} could not be decoded.`))
        media.src = url
      },
    )

    // WebM from MediaRecorder often reports Infinity until it is seeked, which
    // would make every duration calculation downstream produce NaN.
    if (!Number.isFinite(metadata.duration)) {
      const seeked = await coerceDuration(media)
      return { ...metadata, duration: seeked }
    }
    return metadata
  } finally {
    detach(element)
    URL.revokeObjectURL(url)
  }
}

/**
 * Stops a probe element from holding on to its source.
 *
 * Without this the element keeps trying to load a URL we are about to revoke,
 * and Chromium reports the revoked blob as a failed `file://` request — a
 * console error for something that actually worked.
 */
function detach(element: HTMLElement | null): void {
  if (!(element instanceof HTMLMediaElement)) return
  element.onloadedmetadata = null
  element.onerror = null
  element.ontimeupdate = null
  element.removeAttribute('src')
  element.load()
}

/** Forces a real duration out of a stream-recorded file with an unknown length. */
function coerceDuration(element: HTMLMediaElement): Promise<number> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: number) => {
      if (settled) return
      settled = true
      element.ontimeupdate = null
      clearTimeout(timer)
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    }

    element.ontimeupdate = () => settle(element.duration)
    // Seeking far past the end makes the browser resolve the true duration.
    // The element already has its source; re-assigning it would restart the
    // load and lose the metadata we just waited for.
    element.currentTime = 1e6

    const timer = setTimeout(() => settle(element.duration), 2000)
  })
}

export interface IngestOptions {
  kind: AssetKind
  name: string
  prompt?: string
  sourceUrl?: string
  signal?: AbortSignal
}

/**
 * Notified about every newly ingested asset, so it can be copied somewhere
 * durable.
 *
 * This indirection is what keeps Drive out of the ingest path: every panel in
 * the app already calls `ingestBlob`, so registering one hook at startup backs
 * up all of them, and this module stays testable with no Google in sight.
 */
export type IngestListener = (asset: Asset, blob: Blob, options: IngestOptions) => void

let listener: IngestListener | null = null

export function setIngestListener(fn: IngestListener | null): void {
  listener = fn
}

/** Stores a blob plus its metadata and returns the resulting Asset. */
export async function ingestBlob(blob: Blob, options: IngestOptions): Promise<Asset> {
  const id = newId('asset')
  const blobKey = newId('blob')
  const probed = await probeMedia(blob, options.kind).catch(() => ({}))

  const asset: Asset = {
    id,
    kind: options.kind,
    blobKey,
    mimeType: blob.type || defaultMime(options.kind),
    name: options.name,
    createdAt: Date.now(),
    ...probed,
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
  }

  await putBlob(blobKey, blob)
  await putAsset(asset)

  try {
    listener?.(asset, blob, options)
  } catch {
    // A backup that cannot start must not fail the ingest: the asset is
    // already saved locally and usable.
  }

  return asset
}

/** Downloads from a provider URL and stores the result. */
export async function ingestFromUrl(url: string, options: IngestOptions): Promise<Asset> {
  const blob = await fetchMediaBlob(url, options.signal)
  return ingestBlob(blob, { ...options, sourceUrl: url })
}

function defaultMime(kind: AssetKind): string {
  if (kind === 'image') return 'image/png'
  if (kind === 'video') return 'video/mp4'
  return 'audio/webm'
}

/**
 * Turns a stored image into something a video model will accept as its first
 * frame.
 *
 * Handing back the provider's own URL is by far the best case — no bytes move
 * at all. Only user-uploaded images need a data URL, and those get re-encoded
 * to JPEG when large so the request stays under the proxy's payload ceiling.
 */
export async function imageInputFor(asset: Asset, blob: Blob): Promise<string> {
  if (asset.sourceUrl && /^https:\/\//.test(asset.sourceUrl)) return asset.sourceUrl
  if (blob.size <= DATA_URL_REENCODE_THRESHOLD) return await blobToDataUrl(blob)
  return await blobToDataUrl(await reencodeToJpeg(blob))
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(blob)
  })
}

async function reencodeToJpeg(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('That image could not be decoded.'))
      element.src = url
    })

    // Cap the long edge; models do not need more than this for a first frame.
    const maxEdge = 1536
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )
    return jpeg ?? blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Triggers a browser download for an exported file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Give the download a moment to start before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
