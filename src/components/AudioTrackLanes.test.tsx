import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AudioTrackLanes } from './AudioTrackLanes'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import type { Asset, AudioClip, AudioTrack } from '../lib/types'

/**
 * What a chip on an audio lane draws.
 *
 * The shape of the waveform is asserted against a known signal in lib/waveform,
 * and jsdom has no 2D context to paint it into anyway. What is worth pinning
 * here is the wiring: that a chip asks for its clip's sound at all, and that it
 * asks about the take that actually plays rather than the one the clip was
 * recorded from — a converted clip drawing its original voice would be a
 * picture of sound nobody will hear.
 */

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const peaksFor = vi.hoisted(() => vi.fn(() => Promise.resolve(null)))
vi.mock('../lib/audioPeaks', () => ({
  peaksFor,
  cachedPeaks: () => undefined,
  forgetPeaks: () => {},
}))

const track: AudioTrack = { id: 't1', kind: 'voice', name: 'Voice 1', muted: false, volume: 1 }

const asset = (id: string, name: string): Asset => ({
  id,
  kind: 'audio',
  blobKey: `blob_${id}`,
  mimeType: 'audio/webm',
  name,
  duration: 4,
  createdAt: 0,
})

const clip: AudioClip = {
  id: 'a1',
  trackId: 't1',
  assetId: 'take',
  useConverted: false,
  startTime: 1,
  inPoint: 0,
  duration: 3,
}

function mount(overrides: Partial<AudioClip> = {}) {
  useProjectStore.setState({
    project: { ...emptyProject(), audioTracks: [track], audioClips: [{ ...clip, ...overrides }] },
  })
  return render(<AudioTrackLanes zoom={40} targets={new Map()} />)
}

beforeEach(() => {
  peaksFor.mockClear()
  useAssetStore.setState({
    assets: [asset('take', 'Take 1'), asset('converted', 'Converted')],
    loading: false,
  })
})

describe('a clip chip', () => {
  it('draws the sound it holds, inside the chip that holds it', () => {
    mount()

    const chip = screen.getByRole('group', { name: /Your voice/ })
    expect(chip.querySelector('canvas')).not.toBeNull()
    expect(peaksFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'take' }))
  })

  it('draws the converted take, because that is the one that plays', () => {
    mount({ useConverted: true, convertedAssetId: 'converted', voiceName: 'Aria' })

    expect(peaksFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'converted' }))
    expect(peaksFor).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'take' }))
  })

  it('draws nothing rather than failing when the bytes are not on this machine', () => {
    useAssetStore.setState({ assets: [], loading: false })
    mount()

    expect(screen.getByRole('group', { name: /Your voice/ }).querySelector('canvas')).toBeNull()
    expect(peaksFor).not.toHaveBeenCalled()
  })
})
