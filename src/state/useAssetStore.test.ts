/**
 * The catalogue is browser-wide; the library is not.
 *
 * Every panel that produces media — generated, recorded, uploaded, imported —
 * hands it to `add`, so that is the one place a file is claimed by the project
 * that is open. Miss it and the file is on the machine and in nobody's library.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetStore } from './useAssetStore'
import { emptyProject, useProjectStore } from './useProjectStore'
import type { Asset } from '../lib/types'

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
  putAsset: () => Promise.resolve(),
  deleteAsset: () => Promise.resolve(),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
}))

const ASSET: Asset = {
  id: 'asset_new',
  kind: 'image',
  blobKey: 'blob_new',
  mimeType: 'image/png',
  name: 'new.png',
  createdAt: 0,
}

beforeEach(() => {
  useAssetStore.setState({ assets: [], loading: false })
  useProjectStore.setState({ project: emptyProject() })
})

describe('add', () => {
  it('puts the file in the catalogue and in the open project’s library', () => {
    useAssetStore.getState().add(ASSET)

    expect(useAssetStore.getState().assets).toEqual([ASSET])
    expect(useProjectStore.getState().project.libraryAssetIds).toEqual([ASSET.id])
  })

  it('leaves the catalogue alone when the project changes', () => {
    useAssetStore.getState().add(ASSET)
    useProjectStore.setState({ project: emptyProject('other') })

    // Still known to this browser — the timeline of the project it was made for
    // resolves through here — but no longer in the open project's library.
    expect(useAssetStore.getState().byId(ASSET.id)).toEqual(ASSET)
    expect(useProjectStore.getState().project.libraryAssetIds).toEqual([])
  })
})
