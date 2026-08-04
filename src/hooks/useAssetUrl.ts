import { useEffect, useState } from 'react'
import { assetUrl } from '../state/useAssetStore'
import type { Asset } from '../lib/types'

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
export function useAssetUrl(asset: Asset | undefined | null): string | null {
  const [resolved, setResolved] = useState<{ id: string; url: string } | null>(null)

  useEffect(() => {
    if (!asset) return

    let cancelled = false
    assetUrl(asset)
      .then((url) => {
        if (!cancelled) setResolved({ id: asset.id, url })
      })
      .catch(() => {
        // The bytes may be gone but the provider URL can still play.
        if (!cancelled && asset.sourceUrl) setResolved({ id: asset.id, url: asset.sourceUrl })
      })

    return () => {
      cancelled = true
    }
  }, [asset])

  return asset && resolved?.id === asset.id ? resolved.url : null
}
