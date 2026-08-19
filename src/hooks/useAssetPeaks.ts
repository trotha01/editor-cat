import { useEffect, useState } from 'react'
import { cachedPeaks, peaksFor } from '../lib/audioPeaks'
import type { Peaks } from '../lib/waveform'
import type { Asset } from '../lib/types'

/** What is already known about an asset, so a redraw does not flash empty. */
function seed(asset: Asset | undefined | null): { id: string; peaks: Peaks | null } | null {
  if (!asset) return null
  const known = cachedPeaks(asset.id)
  return known === undefined ? null : { id: asset.id, peaks: known }
}

/**
 * The peaks for an asset, decoding it the first time anything asks.
 *
 * Undefined until it is known, because "still decoding" and "decoded, and there
 * was nothing in it" are different states and the second one is worth drawing
 * differently. The decode itself is cached per asset (see lib/audioPeaks), so a
 * lane of eight clips cut from one take costs one decode.
 *
 * What comes back is stored next to the id it belongs to and only returned
 * while that id still matches. Otherwise swapping an audio clip to its
 * converted take would keep drawing the original voice's waveform until the new
 * one finished decoding — a picture of sound that is no longer what plays.
 */
export function useAssetPeaks(asset: Asset | undefined | null): Peaks | null | undefined {
  const [resolved, setResolved] = useState(() => seed(asset))

  useEffect(() => {
    if (!asset) return

    let cancelled = false
    void peaksFor(asset).then((peaks) => {
      if (!cancelled) setResolved({ id: asset.id, peaks })
    })

    return () => {
      cancelled = true
    }
  }, [asset])

  return asset && resolved?.id === asset.id ? resolved.peaks : undefined
}
