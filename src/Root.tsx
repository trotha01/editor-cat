/**
 * Which page is on screen, and the two things both of them need.
 *
 * The catalogue and the backup hook are set up here rather than inside either
 * page, because they are facts about this browser rather than about the editor:
 * a video uploaded on the word pages should reach the user's Drive by exactly
 * the same route as an image generated on the Image tab, and neither page should
 * have to know that route exists.
 */
import { useEffect } from 'react'
import App from './App'
import { WordsPage } from './WordsPage'
import { useRoute } from './lib/route'
import { setIngestListener } from './lib/media'
import { recordAsset } from './lib/sync/assetSync'
import { useAssetStore } from './state/useAssetStore'
import { useDriveStore } from './state/useDriveStore'

export function Root() {
  const route = useRoute()
  const loadAssets = useAssetStore((state) => state.load)

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  useEffect(() => {
    // Every panel and page reaches durable storage through this one hook, so
    // generated images, rendered clips, recordings, manual uploads and the word
    // videos are all backed up and catalogued without any of them knowing Drive
    // or Supabase exist.
    setIngestListener((asset, blob) => {
      useDriveStore.getState().uploadAsset(asset, blob)
      void recordAsset(asset, blob.size)
    })
    return () => setIngestListener(null)
  }, [])

  return route === 'words' ? <WordsPage /> : <App />
}
