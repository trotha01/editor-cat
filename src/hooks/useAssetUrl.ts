import { useEffect, useState } from 'react'
import { assetUrl } from '../state/useAssetStore'
import type { Asset } from '../lib/types'

export interface AssetSource {
  /** Null while the blob is still being read, and for good once it cannot be. */
  url: string | null
  /**
   * Set once there is nothing left to try: the bytes are gone from local
   * storage and there is no provider URL to fall back on. Kept apart from a
   * null url because "still reading" and "will never arrive" look the same from
   * outside and should not: one is worth waiting for and the other is not.
   */
  failed: boolean
}

const PENDING: AssetSource = { url: null, failed: false }
const FAILED: AssetSource = { url: null, failed: true }

/**
 * Resolves an asset to a playable URL.
 *
 * The underlying cache hands back the *same* URL for the same asset every time,
 * which matters: giving a `<video>` a newly-created object URL on each render
 * would reset playback constantly.
 *
 * The resolved URL is stored alongside the id it belongs to, and only returned
 * when that id still matches. Otherwise switching assets would briefly show the
 * previous one's media while the new blob loads.
 */
export function useAssetSource(asset: Asset | undefined | null): AssetSource {
  const [resolved, setResolved] = useState<{ id: string; source: AssetSource } | null>(null)

  useEffect(() => {
    if (!asset) return

    let cancelled = false
    assetUrl(asset)
      .then((url) => {
        if (!cancelled) setResolved({ id: asset.id, source: { url, failed: false } })
      })
      .catch(() => {
        // The bytes may be gone but the provider URL can still play.
        if (cancelled) return
        setResolved({
          id: asset.id,
          source: asset.sourceUrl ? { url: asset.sourceUrl, failed: false } : FAILED,
        })
      })

    return () => {
      cancelled = true
    }
  }, [asset])

  return asset && resolved?.id === asset.id ? resolved.source : PENDING
}

/** The URL alone, for the places that have nothing useful to do about a failure. */
export function useAssetUrl(asset: Asset | undefined | null): string | null {
  return useAssetSource(asset).url
}
