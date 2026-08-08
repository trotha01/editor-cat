/**
 * One frame of an asset, as something a `background-image` can hold.
 *
 * The transition picker draws every option twice over — nine tiles, each
 * blending the shot going out with the shot coming in — and doing that with
 * `<video>` elements would put eighteen decoders on screen to show eighteen
 * frozen frames. Browsers cap how many videos may decode at once, so past the
 * cap the tiles simply come up blank, which is the one thing a picker cannot do.
 *
 * So the frame is taken once, into a canvas, and everything after it is an
 * image. The blobs are our own and same-origin, so nothing here taints the
 * canvas. A still image needs none of this and is handed straight back.
 */
import { useEffect, useState } from 'react'
import { useAssetUrl } from './useAssetUrl'
import type { Asset } from '../lib/types'

/** Wide enough for a tile on a dense display, small enough to be free. */
const FRAME_WIDTH = 240

export function useStillFrame(asset: Asset | undefined, at = 0): string | null {
  const url = useAssetUrl(asset)
  const isVideo = asset?.kind === 'video'
  // Stamped with the source it was taken from, so switching assets never shows
  // the previous one's frame while the next is still being read.
  const [frame, setFrame] = useState<{ from: string; still: string } | null>(null)

  useEffect(() => {
    if (!url || !isVideo) return

    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'

    const draw = () => {
      if (cancelled) return
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) return
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, FRAME_WIDTH / width)
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const context = canvas.getContext('2d')
      if (!context) return
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        setFrame({ from: url, still: canvas.toDataURL('image/jpeg', 0.7) })
      } catch {
        // A source we are not allowed to read leaves the tile empty rather than
        // throwing: the picker still works, it is just less pretty.
      }
    }

    const seek = () => {
      if (cancelled) return
      // Clamped inside the file: asking for the very last frame of a source
      // often lands past the end, and the seek never completes.
      const wanted = Math.max(0, Math.min(at, Math.max(0, (video.duration || 0) - 0.05)))
      if (Math.abs(video.currentTime - wanted) < 0.01) draw()
      else video.currentTime = wanted
    }

    video.addEventListener('loadeddata', seek)
    video.addEventListener('seeked', draw)
    video.src = url

    return () => {
      cancelled = true
      video.removeEventListener('loadeddata', seek)
      video.removeEventListener('seeked', draw)
      // Dropping the source lets the decoder go before the element does.
      video.removeAttribute('src')
      video.load()
    }
  }, [url, isVideo, at])

  if (!isVideo) return url
  return frame?.from === url ? frame.still : null
}
