/**
 * Which page is on screen, and the two things both of them need.
 *
 * The catalogue and the backup hook are set up here rather than inside either
 * page, because they are facts about this browser rather than about the editor:
 * a video uploaded on the word pages should reach storage by exactly the same
 * route as an image generated on the Image tab, and neither page should have to
 * know that route exists.
 */
import { useEffect } from 'react'
import App from './App'
import { WordsPage } from './WordsPage'
import { TrainingPage } from './TrainingPage'
import { useRoute } from './lib/route'
import { setIngestListener } from './lib/media'
import { recordAsset } from './lib/sync/assetSync'
import { useAssetStore } from './state/useAssetStore'
import { useR2Store } from './state/useR2Store'

export function Root() {
  const route = useRoute()
  const loadAssets = useAssetStore((state) => state.load)

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  useEffect(() => {
    // Every panel and page reaches durable storage through this one hook, so
    // generated images, rendered clips, recordings, manual uploads and the word
    // videos are all backed up and catalogued without any of them knowing R2 or
    // Supabase exist.
    setIngestListener((asset, blob) => {
      useR2Store.getState().uploadAsset(asset, blob)
      void recordAsset(asset, blob.size)
    })
    return () => setIngestListener(null)
  }, [])

  if (route === 'words') return <WordsPage />
  // Deliberately outside the ingest hook above: a training set is a few hundred
  // photos on their way to a trainer, not media this app plays back, so it is
  // neither catalogued nor kept in IndexedDB. It uploads and forgets.
  if (route === 'training') return <TrainingPage />
  return <App />
}
