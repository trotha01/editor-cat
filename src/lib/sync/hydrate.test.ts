import { describe, expect, it } from 'vitest'
import { planFor, referencedAssetIds } from './hydrate'
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
    expect(planFor(true, 'drive_1')).toBe('ready')
    // Local bytes win even with no Drive copy — nothing needs fetching.
    expect(planFor(true, undefined)).toBe('ready')
  })

  it('downloads when the bytes are absent but Drive has them', () => {
    expect(planFor(false, 'drive_1')).toBe('download')
  })

  it('reports missing when there is nowhere to fetch from', () => {
    // Generated before Drive was connected: the timeline references it, but
    // the bytes only ever existed on the machine that made them.
    expect(planFor(false, undefined)).toBe('missing')
  })
})

describe('referencedAssetIds', () => {
  it('collects visual clips', () => {
    const ids = referencedAssetIds(
      project({ clips: [clip('c1', 'asset_a'), clip('c2', 'asset_b')] }),
    )
    expect(ids.sort()).toEqual(['asset_a', 'asset_b'])
  })

  it('includes converted takes, which are separate assets', () => {
    // A clip set to use its converted voice plays the converted asset, so a
    // project restored without it opens with silent audio.
    const ids = referencedAssetIds(
      project({
        audioClips: [audioClip('a1', { assetId: 'asset_raw', convertedAssetId: 'asset_conv' })],
      }),
    )
    expect(ids.sort()).toEqual(['asset_conv', 'asset_raw'])
  })

  it('keeps the original take even when the converted one is in use', () => {
    const ids = referencedAssetIds(
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
    const ids = referencedAssetIds(
      project({ clips: [clip('c1', 'asset_a'), clip('c2', 'asset_a')] }),
    )
    expect(ids).toEqual(['asset_a'])
  })

  it('returns nothing for an empty project', () => {
    expect(referencedAssetIds(project())).toEqual([])
  })
})
