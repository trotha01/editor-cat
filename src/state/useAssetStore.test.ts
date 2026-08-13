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

/** What IndexedDB hands back, and how long it takes to hand it back. */
let onDisk: Asset[] = []
let held: () => void = () => {}

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
  putAsset: () => Promise.resolve(),
  deleteAsset: () => Promise.resolve(),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => new Promise<Asset[]>((resolve) => (held = () => resolve(onDisk))),
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
  onDisk = []
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

/**
 * The catalogue is read once, from Root, and other things are resolving files
 * against it while that read is in flight — the word pages catalogue a shelf's
 * takes the moment the account answers, which on a cold IndexedDB is regularly
 * first. Both claims here are about that overlap, and what it costs when it goes
 * wrong is a run of videos that were on the machine a moment ago and now read as
 * files it has never held.
 */
describe('reading the catalogue', () => {
  const TAKE: Asset = {
    id: 'asset_take',
    kind: 'video',
    blobKey: 'blob_take',
    mimeType: 'video/mp4',
    name: 'gato.mp4',
    createdAt: 0,
  }

  it('keeps what arrived while the read was in flight', async () => {
    onDisk = [ASSET]
    const reading = useAssetStore.getState().load()

    useAssetStore.getState().adopt(TAKE)
    held()
    await reading

    expect(useAssetStore.getState().byId(TAKE.id)).toEqual(TAKE)
    expect(useAssetStore.getState().byId(ASSET.id)).toEqual(ASSET)
  })

  it('files one entry per id however many times a file is handed over', () => {
    // Which it is: a take can be picked from Drive and then resolved again out
    // of the shelf's asset rows, and two entries for one id is a catalogue where
    // the answer depends on which lookup asks.
    useAssetStore.getState().adopt(TAKE)
    useAssetStore.getState().adopt({ ...TAKE, name: 'gato-2.mp4' })

    expect(useAssetStore.getState().assets).toEqual([{ ...TAKE, name: 'gato-2.mp4' }])
  })
})
