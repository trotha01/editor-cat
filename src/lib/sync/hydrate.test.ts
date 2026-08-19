import { describe, expect, it } from 'vitest'
import { neededAssetIds, planFor } from './hydrate'
import type { AudioClip, Clip, Project } from '../types'

const clip = (id: string, assetId: string): Clip => ({ id, assetId, inPoint: 0, outPoint: 3 })

const audioClip = (id: string, extra: Partial<AudioClip> = {}): AudioClip => ({
  id,
  trackId: 'track_1',
  assetId: `asset_${id}`,
  useConverted: false,
  startTime: 0,
  inPoint: 0,
  duration: 2,
  ...extra,
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

describe('planFor', () => {
  it('does nothing when the bytes are already in this browser', () => {
    // Local bytes are free and instant; nothing needs fetching either way.
    expect(planFor(true, 'asset/h/a1')).toBe('ready')
    expect(planFor(true, undefined)).toBe('ready')
  })

  it('downloads when the bytes are absent but storage has them', () => {
    expect(planFor(false, 'asset/h/a1')).toBe('download')
  })

  it('reports missing when there is nowhere to fetch from', () => {
    // Made before the upload finished, or on a browser that never reached the
    // network: the timeline references it, but the bytes only ever existed on
    // the machine that made them.
    expect(planFor(false, undefined)).toBe('missing')
  })
})

describe('neededAssetIds', () => {
  it('collects visual clips', () => {
    const ids = neededAssetIds(project({ clips: [clip('c1', 'asset_a'), clip('c2', 'asset_b')] }))
    expect(ids.sort()).toEqual(['asset_a', 'asset_b'])
  })

  it('includes converted takes, which are separate assets', () => {
    // A clip set to use its converted voice plays the converted asset, so a
    // project restored without it opens with silent audio.
    const ids = neededAssetIds(
      project({
        audioClips: [audioClip('a1', { assetId: 'asset_raw', convertedAssetId: 'asset_conv' })],
      }),
    )
    expect(ids.sort()).toEqual(['asset_conv', 'asset_raw'])
  })

  it('keeps the original take even when the converted one is in use', () => {
    const ids = neededAssetIds(
      project({
        audioClips: [
          audioClip('a1', {
            assetId: 'asset_raw',
            convertedAssetId: 'asset_conv',
            useConverted: true,
          }),
        ],
      }),
    )
    // The original is what makes the A/B toggle work after reopening.
    expect(ids).toContain('asset_raw')
  })

  it('deduplicates an asset used by several clips', () => {
    const ids = neededAssetIds(project({ clips: [clip('c1', 'asset_a'), clip('c2', 'asset_a')] }))
    expect(ids).toEqual(['asset_a'])
  })

  it('fetches library files the timeline does not use', () => {
    // The other machine has to be able to *show* the library, not only play the
    // edit: a file generated here and not yet cut in is still one of this
    // project's files, and it would be missing over there without this.
    const ids = neededAssetIds(
      project({ clips: [clip('c1', 'asset_a')], libraryAssetIds: ['asset_a', 'asset_spare'] }),
    )
    expect(ids.sort()).toEqual(['asset_a', 'asset_spare'])
  })

  it('still fetches what the edit uses when the library has forgotten it', () => {
    // Removing a file from the library does not take it off the timeline, and a
    // clip that cannot be played is worse than a library row nobody asked for.
    const ids = neededAssetIds(project({ clips: [clip('c1', 'asset_a')], libraryAssetIds: [] }))
    expect(ids).toEqual(['asset_a'])
  })

  it('returns nothing for an empty project', () => {
    expect(neededAssetIds(project())).toEqual([])
  })
})
