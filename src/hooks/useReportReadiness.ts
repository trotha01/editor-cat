/**
 * Watches one clip's media and files what it finds in the readiness store, so
 * the timeline can say which clips will play through and which are still
 * arriving.
 *
 * Everything here is driven by the element's own events rather than by the
 * playback clock. Sampling on each frame would be simpler to write and much
 * worse to run: `buffered` is a live object, and reading it sixty times a
 * second to notice a change that happens twice is work the preview cannot
 * spare.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { bufferedFraction, readinessFor, type ClipReadiness } from '../lib/readiness'
import { useClipReadiness } from '../state/useClipReadiness'
import type { AssetKind } from '../lib/types'

/**
 * Events after which the answer may have changed. `progress` is the one that
 * carries buffering forward; the rest are the edges — data arriving, data
 * running out, the source being swapped underneath us.
 */
const MEDIA_EVENTS = [
  'loadedmetadata',
  'loadeddata',
  'progress',
  'canplay',
  'canplaythrough',
  'playing',
  'waiting',
  'stalled',
  'suspend',
  'seeked',
  'emptied',
  'error',
] as const

/**
 * Readiness that can be answered without asking an element: no media at all, a
 * source that will never resolve, or a still, which has no buffering to report
 * because an image is either decoded or it is not.
 *
 * Returns null for a video, which is the one case that has to be measured.
 */
function settledReadiness({
  kind,
  url,
  failed,
  warm,
  imageLoaded,
  imageBroken,
}: {
  kind: AssetKind | undefined
  url: string | null
  failed: boolean
  warm: boolean
  imageLoaded: boolean
  imageBroken: boolean
}): ClipReadiness | null {
  if (!kind || failed) return { state: 'missing', buffered: 0 }
  if (!url) return { state: 'loading', buffered: 0 }
  if (kind === 'video') return null
  if (imageBroken) return { state: 'missing', buffered: 0 }
  if (imageLoaded) return { state: 'ready', buffered: 1 }
  return { state: warm ? 'loading' : 'idle', buffered: 0 }
}

export function useReportReadiness({
  clipId,
  videoRef,
  kind,
  url,
  failed,
  from,
  to,
  wanted,
  warm,
  imageLoaded,
  imageBroken,
}: {
  clipId: string
  videoRef: RefObject<HTMLVideoElement | null>
  /** Undefined when the clip points at an asset that is no longer in the library. */
  kind: AssetKind | undefined
  /** Null while the blob is still being read. */
  url: string | null
  /** The source could not be resolved at all: no bytes, no provider URL. */
  failed: boolean
  /** Start of the stretch of source this clip uses. */
  from: number
  /** End of it. Only this range has to be buffered for the clip to play through. */
  to: number
  /** True when the playhead is on this clip and the transport is running. */
  wanted: boolean
  /** True when the clip is near enough the playhead to be worth fetching. */
  warm: boolean
  imageLoaded: boolean
  imageBroken: boolean
}): void {
  const report = useClipReadiness((state) => state.report)
  const forget = useClipReadiness((state) => state.forget)

  const settled = settledReadiness({ kind, url, failed, warm, imageLoaded, imageBroken })
  // Carried as primitives so the effects below can depend on the answer itself
  // rather than on an object rebuilt every render.
  const settledState = settled?.state ?? null
  const settledBuffered = settled?.buffered ?? 0

  // The values a reading needs, kept where a long-lived listener can reach the
  // current ones. Re-subscribing to a dozen events every time the playhead
  // moves would cost more than the reading is worth. Written in an effect
  // declared before the ones that read it, so it is never a render behind.
  const latest = useRef({ from, to, wanted, warm })
  useEffect(() => {
    latest.current = { from, to, wanted, warm }
  }, [from, to, wanted, warm])

  useEffect(() => {
    if (settledState !== null) {
      report(clipId, { state: settledState, buffered: settledBuffered })
      return
    }

    const element = videoRef.current
    if (!element) return

    const sample = () => {
      const { from: start, to: end, wanted: playing, warm: fetching } = latest.current
      report(
        clipId,
        readinessFor({
          failed: Boolean(element.error),
          readyState: element.readyState,
          buffered: bufferedFraction(element.buffered, start, end),
          wanted: playing,
          warm: fetching,
        }),
      )
    }

    sample()
    for (const name of MEDIA_EVENTS) element.addEventListener(name, sample)
    return () => {
      for (const name of MEDIA_EVENTS) element.removeEventListener(name, sample)
    }
  }, [clipId, report, settledBuffered, settledState, videoRef])

  // Crossing onto or off the playhead is what turns "not buffered" into
  // "stalled", and entering the warm window is what turns it into "loading" —
  // no media event fires for either, so they are sampled here instead. Trimming
  // moves the range that has to be buffered, which lands here too.
  useEffect(() => {
    if (settledState !== null) return
    const element = videoRef.current
    if (!element) return
    report(
      clipId,
      readinessFor({
        failed: Boolean(element.error),
        readyState: element.readyState,
        buffered: bufferedFraction(element.buffered, from, to),
        wanted,
        warm,
      }),
    )
  }, [clipId, from, report, settledState, to, videoRef, wanted, warm])

  useEffect(() => () => forget(clipId), [clipId, forget])
}
