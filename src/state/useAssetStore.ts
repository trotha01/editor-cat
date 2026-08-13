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
      const stored = await listAssets()
      // Folded in rather than assigned, because the catalogue can be added to
      // while this read is in flight. The word pages resolve a shelf's takes
      // against it the moment the account answers (see
      // `hydrateShelfAssets`), which on a cold IndexedDB is often before this
      // has finished — and assigning would drop every one of them, leaving the
      // run reading "not on this machine" for files that are.
      set((state) => {
        const held = new Set(state.assets.map((asset) => asset.id))
        return {
          assets: [...state.assets, ...stored.filter((asset) => !held.has(asset.id))],
          loading: false,
        }
      })
    } catch {
      // Whatever was adopted while this was failing is still the truth about
      // this browser, so it stays. There was nothing else to lose: this runs
      // once, from an empty catalogue.
      set({ loading: false })
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
    // Replacing any entry for the same id rather than putting a second one in
    // front of it: a file can be handed over twice — picked from Drive, and
    // resolved again out of the shelf's asset rows — and two entries for one id
    // is a catalogue where which one answers depends on which lookup is asked.
    set((state) => ({
      assets: [asset, ...state.assets.filter((entry) => entry.id !== asset.id)],
    }))
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
