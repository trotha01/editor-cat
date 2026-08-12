import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Asset, Clip } from '../lib/types'

/**
 * "Add all", the one control in the library that acts on more than one asset.
 *
 * Which assets it hands over is the whole of it, and none of it is visible
 * until the timeline comes back wrong: sound has no place on the picture track,
 * a shot already on the timeline should not quietly gain a twin, and the strip
 * is drawn newest-first while a run of shots was generated in the order it is
 * meant to play — so the order that goes to the store is the reverse of the
 * order on screen.
 */

// The panel renders real <img> tags, and object URLs need bytes in IndexedDB.
vi.mock('../hooks/useAssetUrl', () => ({
  useAssetUrl: () => 'blob:fake',
}))

vi.mock('../hooks/useDriveImport', () => ({
  useDriveImport: () => ({ progress: null, error: null, start: () => Promise.resolve() }),
}))

vi.mock('../state/useDriveStore', () => ({
  useDriveStore: (selector: (state: { status: string; folder: null }) => unknown) =>
    selector({ status: 'disconnected', folder: null }),
}))

const addClips = vi.fn()

const projectState = {
  project: { clips: [] as Clip[] },
  addClip: vi.fn(),
  addClips: (assets: readonly Asset[], atTime?: number) => addClips(assets, atTime),
  addVideoClip: vi.fn(),
}

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
}))

const { LibraryPanel } = await import('./LibraryPanel')
const { useAssetStore } = await import('../state/useAssetStore')

function asset(id: string, kind: Asset['kind'], createdAt: number): Asset {
  return {
    id,
    kind,
    blobKey: `blob_${id}`,
    mimeType: kind === 'audio' ? 'audio/wav' : 'image/png',
    name: `${id}.${kind === 'audio' ? 'wav' : 'png'}`,
    createdAt,
  }
}

/** The library, newest first, which is the order it is stored and drawn in. */
function library(...assets: Asset[]) {
  useAssetStore.setState({ assets, loading: false })
}

const addAll = () => screen.getByRole('button', { name: /add all/i })

/** The asset ids handed to the store by the last press. */
const handedOver = () =>
  (addClips.mock.calls.at(-1)?.[0] as readonly Asset[]).map((added) => added.id)

beforeEach(() => {
  addClips.mockClear()
  projectState.project = { clips: [] }
  library()
})

describe('add all', () => {
  it('hands over the whole library oldest first, at the playhead', () => {
    library(asset('third', 'image', 3), asset('second', 'video', 2), asset('first', 'image', 1))

    render(<LibraryPanel currentTime={2.5} />)
    fireEvent.click(addAll())

    expect(handedOver()).toEqual(['first', 'second', 'third'])
    expect(addClips.mock.calls.at(-1)?.[1]).toBe(2.5)
  })

  it('leaves out sound and anything already on the timeline', () => {
    library(asset('still', 'image', 3), asset('music', 'audio', 2), asset('shot', 'video', 1))
    projectState.project = { clips: [{ id: 'clip-1', assetId: 'shot', inPoint: 0, outPoint: 2 }] }

    render(<LibraryPanel currentTime={0} />)
    // The count says what is about to happen before it happens.
    expect(addAll()).toHaveTextContent('Add all (1)')
    fireEvent.click(addAll())

    expect(handedOver()).toEqual(['still'])
  })

  it('has nothing left to do once every shot is on the timeline', () => {
    library(asset('still', 'image', 1))
    projectState.project = { clips: [{ id: 'clip-1', assetId: 'still', inPoint: 0, outPoint: 4 }] }

    render(<LibraryPanel currentTime={0} />)

    expect(addAll()).toBeDisabled()
  })

  it('is not offered when there is no picture to add', () => {
    // Sound only: the Audio step places that, on a lane of its own.
    library(asset('music', 'audio', 1))

    render(<LibraryPanel currentTime={0} />)

    expect(screen.queryByRole('button', { name: /add all/i })).toBeNull()
  })
})
