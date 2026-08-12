/**
 * What a project's library holds.
 *
 * The rule these all circle is that the library and the timeline are separate
 * facts about a project: taking a shot out of the edit leaves the file where it
 * was, and only deleting it from the library takes it out.
 */
import { describe, expect, it } from 'vitest'
import {
  isAssetOrphaned,
  libraryAssetIdsOf,
  libraryAssets,
  referencedAssetIds,
  withBackfilledLibrary,
  withLibraryAsset,
  withoutLibraryAsset,
} from './library'
import type { Asset, AudioClip, Clip, Project, VideoClip } from './types'

const clip = (id: string, assetId: string): Clip => ({ id, assetId, inPoint: 0, outPoint: 3 })

const videoClip = (id: string, assetId: string): VideoClip => ({
  id,
  trackId: 'vtrack_1',
  assetId,
  startTime: 0,
  inPoint: 0,
  duration: 2,
})

const audioClip = (id: string, assetId: string, convertedAssetId?: string): AudioClip => ({
  id,
  trackId: 'track_1',
  assetId,
  useConverted: false,
  startTime: 0,
  inPoint: 0,
  duration: 2,
  ...(convertedAssetId ? { convertedAssetId } : {}),
})

const asset = (id: string): Asset => ({
  id,
  kind: 'image',
  blobKey: `blob_${id}`,
  mimeType: 'image/png',
  name: id,
  createdAt: 0,
})

const project = (extra: Partial<Project> = {}): Project => ({
  id: 'project_1',
  name: 'Test',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 1280,
  height: 720,
  fps: 30,
  ...extra,
})

describe('referencedAssetIds', () => {
  it('collects the picture, the layers and the audio', () => {
    const ids = referencedAssetIds(
      project({
        clips: [clip('c1', 'asset_a')],
        videoClips: [videoClip('v1', 'asset_layer')],
        audioClips: [audioClip('a1', 'asset_raw', 'asset_conv')],
      }),
    )
    expect(ids.sort()).toEqual(['asset_a', 'asset_conv', 'asset_layer', 'asset_raw'])
  })

  it('deduplicates an asset used by several clips', () => {
    expect(
      referencedAssetIds(project({ clips: [clip('c1', 'asset_a'), clip('c2', 'asset_a')] })),
    ).toEqual(['asset_a'])
  })
})

describe('libraryAssetIdsOf', () => {
  it('reads a project saved before the list existed as the files its edit uses', () => {
    expect(libraryAssetIdsOf(project({ clips: [clip('c1', 'asset_a')] }))).toEqual(['asset_a'])
  })

  it('takes an empty list at its word', () => {
    // The difference that matters: absent means "we do not know", empty means
    // the user emptied it — or that the project is new, which is the same thing
    // said before anything has happened.
    expect(
      libraryAssetIdsOf(project({ clips: [clip('c1', 'asset_a')], libraryAssetIds: [] })),
    ).toEqual([])
  })
})

describe('withBackfilledLibrary', () => {
  it('writes down what an absent list was being read as', () => {
    const backfilled = withBackfilledLibrary(project({ clips: [clip('c1', 'asset_a')] }))
    expect(backfilled.libraryAssetIds).toEqual(['asset_a'])
  })

  it('leaves a project that already has one alone', () => {
    const existing = project({ clips: [clip('c1', 'asset_a')], libraryAssetIds: ['asset_b'] })
    expect(withBackfilledLibrary(existing)).toBe(existing)
  })
})

describe('withLibraryAsset', () => {
  it('adds a file', () => {
    const next = withLibraryAsset(project({ libraryAssetIds: ['asset_a'] }), 'asset_b')
    expect(next.libraryAssetIds).toEqual(['asset_a', 'asset_b'])
  })

  it('hands the project straight back when the file is already in', () => {
    // Identity matters: a new object here is an edit as far as the sync
    // scheduler is concerned, and would push the same document again.
    const existing = project({ libraryAssetIds: ['asset_a'] })
    expect(withLibraryAsset(existing, 'asset_a')).toBe(existing)
  })
})

describe('withoutLibraryAsset', () => {
  it('removes a file', () => {
    const next = withoutLibraryAsset(
      project({ libraryAssetIds: ['asset_a', 'asset_b'] }),
      'asset_a',
    )
    expect(next.libraryAssetIds).toEqual(['asset_b'])
  })

  it('removes one that is still on the timeline of a project saved without a list', () => {
    // The list is derived until something writes it down, and a derived one
    // would hand the file straight back on the next read — which would make a
    // file that is in use impossible to take out of the library.
    const next = withoutLibraryAsset(project({ clips: [clip('c1', 'asset_a')] }), 'asset_a')
    expect(next.libraryAssetIds).toEqual([])
    expect(libraryAssetIdsOf(next)).toEqual([])
  })

  it('leaves a file that is not in the library alone', () => {
    const existing = project({ libraryAssetIds: ['asset_a'] })
    expect(withoutLibraryAsset(existing, 'asset_b')).toBe(existing)
  })
})

describe('libraryAssets', () => {
  it('keeps only the files this project lists, in catalogue order', () => {
    const catalogue = [asset('asset_c'), asset('asset_b'), asset('asset_a')]
    const listed = libraryAssets(catalogue, project({ libraryAssetIds: ['asset_a', 'asset_c'] }))
    expect(listed.map((entry) => entry.id)).toEqual(['asset_c', 'asset_a'])
  })

  it('skips a file whose metadata has not arrived yet', () => {
    // Between opening a project on a second machine and hydration finishing,
    // the ids are known and the assets are not.
    expect(libraryAssets([], project({ libraryAssetIds: ['asset_a'] }))).toEqual([])
  })
})

describe('isAssetOrphaned', () => {
  const other = (extra: Partial<Project>) => project({ id: 'project_2', ...extra })

  it('is false while another project still lists the file', () => {
    expect(isAssetOrphaned('asset_a', [other({ libraryAssetIds: ['asset_a'] })])).toBe(false)
  })

  it('is false while another project still uses the file', () => {
    // Off that project's library but still cut into its timeline: deleting the
    // bytes would break a clip somebody is still editing.
    expect(
      isAssetOrphaned('asset_a', [other({ clips: [clip('c1', 'asset_a')], libraryAssetIds: [] })]),
    ).toBe(false)
  })

  it('is true when nothing on this machine refers to it', () => {
    expect(isAssetOrphaned('asset_a', [other({ libraryAssetIds: ['asset_b'] })])).toBe(true)
  })
})
