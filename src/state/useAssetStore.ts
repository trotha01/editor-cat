/**
 * The asset catalogue: every file this browser holds the bytes for.
 *
 * Browser-wide rather than per project, because that is what it is for —
 * resolving the asset a clip names, wherever the clip came from. Which of these
 * files a project *shows* is the project's own library list, kept on the
 * document; see lib/library.ts.
 *
 * Object URLs are cached per asset rather than created per render — a
 * `<video>` whose src changes identity on every render will restart playback,
 * which makes the preview stutter constantly.
 */
import { create } from 'zustand'
import { deleteAsset as dbDeleteAsset, getBlob, listAssets, putAsset } from '../lib/db'
import { forgetPeaks } from '../lib/audioPeaks'
import { useProjectStore } from './useProjectStore'
import type { Asset } from '../lib/types'

const urlCache = new Map<string, string>()

interface AssetState {
  assets: Asset[]
  loading: boolean
  load: () => Promise<void>
  add: (asset: Asset) => void
  /**
   * Into the catalogue, and into nobody's library.
   *
   * For media that belongs to something other than a timeline — a word's videos
   * (see lib/words.ts), which are held in a list of their own and would only
   * clutter the open project if they were claimed by it. Everything else should
   * still come through `add`: a file on the machine that no project lists is a
   * file with nothing on screen to reach it by, and that is the right answer
   * here only because the word pages are the something else.
   */
  adopt: (asset: Asset) => void
  update: (id: string, patch: Partial<Asset>) => Promise<void>
  remove: (id: string) => Promise<void>
  byId: (id: string) => Asset | undefined
}

export const useAssetStore = create<AssetState>((set, get) => ({
  assets: [],
  loading: true,

  load: async () => {
    set({ loading: true })
    try {
      set({ assets: await listAssets(), loading: false })
    } catch {
      set({ assets: [], loading: false })
    }
  },

  add: (asset) => {
    // A file arriving in this session — generated, recorded, uploaded or
    // imported — was made for the project that is open, so it joins that
    // project's library. Every panel that produces media comes through here,
    // which is what makes that one rule rather than seven.
    useProjectStore.getState().addToLibrary(asset.id)
    get().adopt(asset)
  },

  adopt: (asset) => {
    set((state) => ({ assets: [asset, ...state.assets] }))
  },

  update: async (id, patch) => {
    const existing = get().assets.find((asset) => asset.id === id)
    if (!existing) return
    const next = { ...existing, ...patch }
    await putAsset(next)
    set((state) => ({ assets: state.assets.map((asset) => (asset.id === id ? next : asset)) }))
  },

  remove: async (id) => {
    await dbDeleteAsset(id)
    releaseAssetUrl(id)
    // The bytes these were read from are gone, so holding on to them would be
    // caching a waveform for a file that no longer exists.
    forgetPeaks(id)
    set((state) => ({ assets: state.assets.filter((asset) => asset.id !== id) }))
  },

  byId: (id) => get().assets.find((asset) => asset.id === id),
}))

/** Resolves an asset to a stable object URL, loading the blob on first use. */
export async function assetUrl(asset: Asset): Promise<string> {
  const cached = urlCache.get(asset.id)
  if (cached) return cached

  const blob = await getBlob(asset.blobKey)
  if (!blob) {
    // The bytes are gone but we may still have the provider URL to fall back on.
    if (asset.sourceUrl) return asset.sourceUrl
    throw new Error(`The media for "${asset.name}" is no longer in local storage.`)
  }

  const url = URL.createObjectURL(blob)
  urlCache.set(asset.id, url)
  return url
}

export function releaseAssetUrl(assetId: string): void {
  const url = urlCache.get(assetId)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(assetId)
  }
}

export function releaseAllAssetUrls(): void {
  urlCache.forEach((url) => URL.revokeObjectURL(url))
  urlCache.clear()
}
