/**
 * Decoding a clip's sound, once, so it can be drawn.
 *
 * The decode is the expensive part — the browser has to demux the file and run
 * the audio codec over all of it — so it happens once per asset and what is
 * kept is the peak array, a few kilobytes, rather than the decoded buffer,
 * which for a minute of stereo is ten megabytes. Zooming, trimming and cutting
 * all redraw from that array without touching the file again.
 *
 * Failure is a normal outcome, not an error: a clip may be a still, may have no
 * audio track, or may be in something this browser cannot decode. All three
 * come back as `null` — "there is nothing to draw" — because a waveform is a
 * convenience and must never be the reason an edit fails.
 */
import { getBlob } from './db'
import { computePeaks, type Peaks } from './waveform'
import type { Asset } from './types'

/** Peaks by asset id. `null` means decoded, and there was nothing in it. */
const cache = new Map<string, Peaks | null>()

/** In-progress decodes, so eight clips of one asset decode it once. */
const inFlight = new Map<string, Promise<Peaks | null>>()

/**
 * A context purely for decoding.
 *
 * Offline rather than a live AudioContext: nothing here is ever played, and an
 * offline one cannot be blocked by an autoplay policy or leave hardware open.
 */
function decodeContext(): BaseAudioContext | null {
  if (typeof OfflineAudioContext === 'undefined') return null
  // One frame at a standard rate — the size is irrelevant to decoding, and
  // zero-length is not allowed.
  return new OfflineAudioContext(1, 1, 44100)
}

async function decode(asset: Asset): Promise<Peaks | null> {
  if (asset.kind === 'image') return null

  const context = decodeContext()
  if (!context) return null

  const blob = await getBlob(asset.blobKey)
  if (!blob) return null

  // decodeAudioData detaches the buffer it is given, which is fine: this one
  // is made here and never used again.
  const decoded = await context.decodeAudioData(await blob.arrayBuffer())
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
    decoded.getChannelData(index),
  )

  const peaks = computePeaks(channels, decoded.sampleRate)
  return peaks.values.length > 0 ? peaks : null
}

/** Peaks for an asset, decoding it the first time and remembering after. */
export async function peaksFor(asset: Asset): Promise<Peaks | null> {
  const known = cache.get(asset.id)
  if (known !== undefined) return known

  const running = inFlight.get(asset.id)
  if (running) return running

  const work = decode(asset)
    .catch(() => null)
    .then((peaks) => {
      cache.set(asset.id, peaks)
      inFlight.delete(asset.id)
      return peaks
    })

  inFlight.set(asset.id, work)
  return work
}

/** What is already known, without starting a decode. Undefined means unknown. */
export function cachedPeaks(assetId: string): Peaks | null | undefined {
  return cache.get(assetId)
}

/** Drops an asset's peaks. Called when its bytes are deleted. */
export function forgetPeaks(assetId: string): void {
  cache.delete(assetId)
  inFlight.delete(assetId)
}
