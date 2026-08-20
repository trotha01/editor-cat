import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
  return render(<AudioTrackLanes zoom={40} currentTime={0} targets={new Map()} />)
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

/**
 * Dragging a chip that is part of a marquee's group, which moves the whole
 * group by the distance that one chip travelled.
 *
 * The thing worth pinning is that the group is measured from where it began
 * rather than from where it is: a drag reports the same pointer position many
 * times over, and a group re-measured on every event would run away down the
 * timeline instead of tracking the pointer.
 */
describe('dragging a group of clips', () => {
  const second: AudioClip = { ...clip, id: 'a2', startTime: 6, duration: 2 }

  function mountPair(selectedIds: string[]) {
    useProjectStore.setState({
      project: { ...emptyProject(), audioTracks: [track], audioClips: [clip, second] },
      selectedIds,
      selectedAudioClipId: null,
    })
    render(<AudioTrackLanes zoom={40} currentTime={0} targets={new Map()} />)
    return screen.getAllByRole('group')[0]!
  }

  const starts = () => useProjectStore.getState().project.audioClips.map((entry) => entry.startTime)

  it('carries the rest of the group along, keeping the spacing', () => {
    const chip = mountPair(['a1', 'a2'])

    // 40px/s, so 80px is two seconds later. Twice, at the same place: the
    // second event must land the group where the first one did.
    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, pointerId: 1, button: 0 })
    fireEvent.pointerMove(chip, { clientX: 80, clientY: 0, pointerId: 1 })
    expect(starts()).toEqual([3, 8])
    fireEvent.pointerMove(chip, { clientX: 80, clientY: 0, pointerId: 1 })

    expect(starts()).toEqual([3, 8])
  })

  it('keeps the group rather than narrowing to the chip that was picked up', () => {
    const chip = mountPair(['a1', 'a2'])

    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, pointerId: 1, button: 0 })

    expect(useProjectStore.getState().selectedIds).toEqual(['a1', 'a2'])
    expect(useProjectStore.getState().selectedAudioClipId).toBeNull()
  })

  it('moves one clip alone when it was not part of the group', () => {
    const chip = mountPair(['a2'])

    fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, pointerId: 1, button: 0 })
    fireEvent.pointerMove(chip, { clientX: 80, clientY: 0, pointerId: 1 })

    expect(starts()).toEqual([3, 6])
    // Picking a clip outside the group is also how the group is let go of.
    expect(useProjectStore.getState().selectedIds).toEqual([])
  })
})
