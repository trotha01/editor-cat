/**
 * One frame out of a rendered export, as a JPEG.
 *
 * Mintspace's feed cards set the frame as the `<video poster>`, which is what
 * fills a card that has been scrolled to but has not started playing — and,
 * more visibly, every card further down the feed that has only loaded its
 * metadata. Without one those are black rectangles, so it is worth the second
 * or so this takes.
 *
 * Every failure here returns null instead of throwing. A poster is decoration
 * on a nullable column: a publish that fell over because a thumbnail could not
 * be drawn would be a bad trade, and the browsers most likely to refuse this —
 * an unusual codec, a decoder already at its limit — are exactly the ones where
 * the user has the least idea what to do about it.
 */

/** Wide enough for a phone-sized card at 2×, small enough to be free. */
const MAX_WIDTH = 720

/**
 * A frame that never arrives must not hold the publish up. Generous, because
 * this runs immediately after an export the same machine just encoded, and the
 * decoder may still be busy letting go of it.
 */
const TIMEOUT_MS = 15_000

export interface PosterOptions {
  /**
   * Seconds into the file to take the frame from. Worth passing something past
   * any lead-in: a project that opens on black would otherwise be posterised
   * with that black.
   */
  at?: number
  maxWidth?: number
}

export async function posterFrame(video: Blob, options: PosterOptions = {}): Promise<Blob | null> {
  const { at = 0, maxWidth = MAX_WIDTH } = options

  // Our own bytes, from our own origin, so the canvas this is drawn into stays
  // readable — a tainted one would fail at toBlob rather than at drawImage,
  // which is a confusing place to find out.
  const url = URL.createObjectURL(video)
  const element = document.createElement('video')
  element.muted = true
  element.playsInline = true
  element.preload = 'auto'

  try {
    return await new Promise<Blob | null>((resolve) => {
      let settled = false

      const finish = (result: Blob | null) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        element.removeAttribute('src')
        element.load()
        resolve(result)
      }

      const timer = window.setTimeout(() => finish(null), TIMEOUT_MS)

      const draw = () => {
        const width = element.videoWidth
        const height = element.videoHeight
        if (!width || !height) return finish(null)

        const canvas = document.createElement('canvas')
        const scale = Math.min(1, maxWidth / width)
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        const context = canvas.getContext('2d')
        if (!context) return finish(null)

        try {
          context.drawImage(element, 0, 0, canvas.width, canvas.height)
        } catch {
          return finish(null)
        }
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.82)
      }

      element.addEventListener('error', () => finish(null))
      element.addEventListener('seeked', draw)
      element.addEventListener('loadeddata', () => {
        // Clamped inside the file, and never onto the very last frame: seeking
        // to exactly `duration` lands past the end in some browsers and fires
        // no `seeked` at all.
        const duration = Number.isFinite(element.duration) ? element.duration : 0
        const target = Math.min(Math.max(at, 0), Math.max(duration - 0.05, 0))

        // A seek to where the head already is fires nothing, so that case draws
        // what has already been decoded rather than waiting for an event that
        // is not coming.
        if (Math.abs(element.currentTime - target) < 0.01) return draw()
        element.currentTime = target
      })

      element.src = url
      element.load()
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
