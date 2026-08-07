/**
 * Fetching the caption typeface for the export.
 *
 * ffmpeg.wasm's filesystem starts empty, so the faces libass will need have to
 * be read over the network and written into it. They are fetched here rather
 * than bundled because a project with no captions should never pay for 700KB of
 * glyphs, and cached because a second export of the same project should not
 * fetch them again.
 *
 * A face that cannot be fetched is a hard failure, deliberately: libass with no
 * font renders nothing and still exits successfully, so letting this pass would
 * hand back an MP4 that quietly has no captions in it.
 */
import { CAPTION_FONT_URLS } from '../captions'
import type { CaptionFont } from './render'

/**
 * Cached as buffers, and handed out as copies.
 *
 * `ffmpeg.writeFile` *transfers* the Uint8Array's buffer into the worker rather
 * than copying it, which detaches it here. Handing the same array over twice
 * means the second export writes a zero-length font — and libass with an
 * unreadable font draws nothing and still exits successfully, so the failure
 * would arrive as an MP4 that quietly has no captions in it.
 */
const cache = new Map<string, ArrayBuffer>()

/** File names inside the ffmpeg fonts directory. Only ever ours to choose. */
const FILE_NAMES = {
  regular: 'Inter-Regular.ttf',
  bold: 'Inter-Bold.ttf',
} as const

async function load(url: string): Promise<Uint8Array> {
  const cached = cache.get(url)
  if (cached) return new Uint8Array(cached.slice(0))

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `The caption font could not be loaded (${response.status} for ${url}), so captions ` +
        `cannot be drawn into the video.`,
    )
  }
  const buffer = await response.arrayBuffer()
  cache.set(url, buffer)
  return new Uint8Array(buffer.slice(0))
}

/**
 * The faces needed for a set of caption styles.
 *
 * Only the weights actually in use are fetched — a project whose captions are
 * all bold, which is the default, never downloads the regular face.
 */
export async function captionFonts(
  styles: readonly { bold: boolean }[],
): Promise<readonly CaptionFont[]> {
  const weights = new Set<keyof typeof FILE_NAMES>(
    styles.map((style) => (style.bold ? 'bold' : 'regular')),
  )
  return Promise.all(
    [...weights].map(async (weight) => ({
      fileName: FILE_NAMES[weight],
      bytes: await load(CAPTION_FONT_URLS[weight]),
    })),
  )
}
