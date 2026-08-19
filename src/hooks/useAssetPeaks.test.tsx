import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useAssetPeaks } from './useAssetPeaks'
import type { Peaks } from '../lib/waveform'
import type { Asset } from '../lib/types'

/**
 * Which asset's sound the caller is holding.
 *
 * The decoding and the bucketing are tested where they live. What is left here
 * is the join between them and the component: a decode that finishes after the
 * clip has been pointed at something else must not be drawn as if it were the
 * new one's, and a clip whose asset has changed must go back to saying nothing
 * rather than showing the old picture until the new decode lands.
 */

/** Decodes that are running, so a test can finish one when it chooses to. */
const pending = new Map<string, (peaks: Peaks | null) => void>()

const { peaksFor, cachedPeaks } = vi.hoisted(() => ({
  peaksFor: vi.fn(),
  cachedPeaks: vi.fn(),
}))

vi.mock('../lib/audioPeaks', () => ({ peaksFor, cachedPeaks, forgetPeaks: () => {} }))

const asset = (id: string): Asset => ({
  id,
  kind: 'audio',
  blobKey: `blob_${id}`,
  mimeType: 'audio/webm',
  name: id,
  createdAt: 0,
})

const peaks = (level: number): Peaks => ({
  values: Float32Array.from([level]),
  perSecond: 100,
})

function Harness({ id }: { id: string }) {
  const held = useAssetPeaks(asset(id))
  return <p data-testid="peaks">{held === undefined ? 'unknown' : (held?.values[0] ?? 'silent')}</p>
}

const shown = () => screen.getByTestId('peaks').textContent

beforeEach(() => {
  pending.clear()
  cachedPeaks.mockReturnValue(undefined)
  peaksFor.mockImplementation(
    (subject: Asset) =>
      new Promise<Peaks | null>((resolve) => {
        pending.set(subject.id, resolve)
      }),
  )
})

/** Finishes one asset's decode and lets React render what came back. */
async function finish(id: string, result: Peaks | null) {
  await act(async () => {
    pending.get(id)?.(result)
  })
}

describe('useAssetPeaks', () => {
  it('says nothing until the decode comes back', async () => {
    render(<Harness id="one" />)
    expect(shown()).toBe('unknown')

    await finish('one', peaks(0.5))
    expect(shown()).toBe('0.5')
  })

  it('tells silence apart from not knowing yet', async () => {
    render(<Harness id="one" />)

    await finish('one', null)
    expect(shown()).toBe('silent')
  })

  it('drops the old asset the moment it is pointed at another', async () => {
    const view = render(<Harness id="one" />)
    await finish('one', peaks(0.5))

    // Switching to the converted take: what is on screen is the wrong sound
    // from this instant, whatever the new decode is still doing.
    view.rerender(<Harness id="two" />)
    expect(shown()).toBe('unknown')

    await finish('two', peaks(0.25))
    expect(shown()).toBe('0.25')
  })

  it('ignores a decode that lands after the asset has moved on', async () => {
    const view = render(<Harness id="one" />)
    view.rerender(<Harness id="two" />)

    await finish('two', peaks(0.25))
    // The first asset's decode was already running and cannot be called off;
    // it arrives late, and belongs to nothing on screen.
    await finish('one', peaks(0.5))

    expect(shown()).toBe('0.25')
  })

  it('draws straight away when the decode has already been done once', () => {
    cachedPeaks.mockReturnValue(peaks(0.75))
    render(<Harness id="one" />)

    // No flash of an empty lane when a chip is remounted — dragging one between
    // lanes, or scrolling the timeline, must not blank its waveform.
    expect(shown()).toBe('0.75')
  })
})
