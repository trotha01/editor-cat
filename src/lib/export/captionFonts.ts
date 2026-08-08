/**
 * Fetching the caption typeface for the export.
 *
 * ffmpeg.wasm's filesystem starts empty, so the face libass will need has to be
 * read over the network and written into it. It is fetched here rather than
 * bundled because a project with no captions should never pay for the glyphs,
 * and cached because a second export of the same project should not fetch them
 * again.
 *
 * A face that cannot be fetched is a hard failure, deliberately: libass with no
 * font renders nothing and still exits successfully, so letting this pass would
 * hand back an MP4 that quietly has no captions in it.
 */
import { CAPTION_FONT_URL } from '../captions'
import type { CaptionFont } from './render'

/**
 * Cached as a buffer, and handed out as copies.
 *
 * `ffmpeg.writeFile` *transfers* the Uint8Array's buffer into the worker rather
 * than copying it, which detaches it here. Handing the same array over twice
 * means the second export writes a zero-length font — and libass with an
 * unreadable font draws nothing and still exits successfully, so the failure
 * would arrive as an MP4 that quietly has no captions in it.
 */
let cached: ArrayBuffer | null = null

/** File name inside the ffmpeg fonts directory. Only ever ours to choose. */
const FILE_NAME = 'LindyToonWide-Regular.ttf'

/**
 * The faces libass needs, as files to drop in its fonts directory.
 *
 * One, because the shipped family has one weight: a bold caption is that same
 * face emboldened, which libass does itself from the style's bold flag. Still a
 * list, since the directory is what libass is pointed at — a second weight is a
 * second entry and nothing else changes.
 */
export async function captionFonts(): Promise<readonly CaptionFont[]> {
  if (!cached) {
    const response = await fetch(CAPTION_FONT_URL)
    if (!response.ok) {
      throw new Error(
        `The caption font could not be loaded (${response.status} for ${CAPTION_FONT_URL}), so ` +
          `captions cannot be drawn into the video.`,
      )
    }
    cached = await response.arrayBuffer()
  }
  return [{ fileName: FILE_NAME, bytes: new Uint8Array(cached.slice(0)) }]
}
