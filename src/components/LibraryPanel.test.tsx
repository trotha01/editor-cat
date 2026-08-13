/**
 * The Library panel: this project's files and nobody else's, plus "Add all",
 * the one control in it that acts on more than one asset.
 *
 * The catalogue behind it is browser-wide, so the panel used to list every file
 * this machine had ever made — a new project opened with a library full of
 * another project's shots. These cover what is listed, what deleting a row
 * actually does, and — for "Add all" — which assets it hands over: sound has no
 * place on the picture track, a shot already on the timeline should not
 * quietly gain a twin, and the strip is drawn newest-first while a run of shots
 * was generated in the order it is meant to play, so the order that goes to the
 * store is the reverse of the order on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LibraryPanel } from './LibraryPanel'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import type { Asset, Project } from '../lib/types'

const listProjects = vi.fn<() => Promise<Project[]>>()
const deleteAsset = vi.fn<(id: string) => Promise<void>>()

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
  listProjects: () => listProjects(),
  deleteAsset: (id: string) => deleteAsset(id),
  getBlob: () => Promise.resolve(undefined),
}))

// The rows render real <img> tags, and object URLs need bytes in IndexedDB.
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

// The real store's actions, captured once so each test can be reset back to
// them — a test that swaps in a spy for one action must not leave that spy
// behind for the next describe block.
const realActions = useProjectStore.getState()

function imageAsset(id: string, name: string): Asset {
  return {
    id,
    kind: 'image',
    blobKey: `blob_${id}`,
    mimeType: 'image/png',
    name,
    createdAt: 0,
  }
}

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

const MINE = imageAsset('asset_mine', 'mine.png')
const THEIRS = imageAsset('asset_theirs', 'theirs.png')

/** Puts the given assets in the catalogue and in this project's library. */
function library(...assets: Asset[]) {
  useAssetStore.setState({ assets, loading: false })
  useProjectStore.setState((state) => ({
    project: { ...state.project, libraryAssetIds: assets.map((entry) => entry.id) },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  listProjects.mockResolvedValue([])
  deleteAsset.mockResolvedValue(undefined)
  useAssetStore.setState({ assets: [MINE, THEIRS], loading: false })
  useProjectStore.setState(
    { ...realActions, project: { ...emptyProject(), libraryAssetIds: [MINE.id] } },
    true,
  )
})

describe('what the library lists', () => {
  it('leaves out a file that belongs to another project', () => {
    render(<LibraryPanel />)

    expect(screen.getByText('mine.png')).toBeInTheDocument()
    expect(screen.queryByText('theirs.png')).not.toBeInTheDocument()
  })

  it('is empty on a new project, however full the machine is', () => {
    useProjectStore.setState({ project: emptyProject() })
    render(<LibraryPanel />)

    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.queryByText('mine.png')).not.toBeInTheDocument()
  })

  it('keeps a file that has been taken off the timeline', () => {
    act(() => {
      useProjectStore.getState().addClip(MINE)
    })
    const clipId = useProjectStore.getState().project.clips[0]!.id
    act(() => {
      useProjectStore.getState().removeClip(clipId)
    })

    render(<LibraryPanel />)
    expect(screen.getByText('mine.png')).toBeInTheDocument()
  })
})

describe('deleting a row', () => {
  it('takes the file out of this project and out of storage', async () => {
    render(<LibraryPanel />)

    screen.getByRole('button', { name: 'Remove mine.png from the library' }).click()

    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith(MINE.id))
    expect(useProjectStore.getState().project.libraryAssetIds).toEqual([])
    expect(screen.queryByText('mine.png')).not.toBeInTheDocument()
  })

  it('keeps the bytes when another project still wants them', async () => {
    // The same asset can be in two libraries — importing a Drive file that is
    // already here adopts the copy — and this button is about this project.
    listProjects.mockResolvedValue([
      { ...emptyProject('other'), libraryAssetIds: [MINE.id] },
      { ...emptyProject(), libraryAssetIds: [MINE.id] },
    ])

    render(<LibraryPanel />)
    screen.getByRole('button', { name: 'Remove mine.png from the library' }).click()

    await waitFor(() => expect(useProjectStore.getState().project.libraryAssetIds).toEqual([]))
    expect(deleteAsset).not.toHaveBeenCalled()
  })

  it('keeps the bytes when this project is still cutting with them', async () => {
    // Off the library but still in the edit: the clip has to keep playing.
    act(() => {
      useProjectStore.getState().addClip(MINE)
    })

    render(<LibraryPanel />)
    screen.getByRole('button', { name: 'Remove mine.png from the library' }).click()

    await waitFor(() => expect(useProjectStore.getState().project.libraryAssetIds).toEqual([]))
    expect(deleteAsset).not.toHaveBeenCalled()
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })
})

describe('add all', () => {
  const addClips = vi.fn()

  beforeEach(() => {
    addClips.mockClear()
    useProjectStore.setState({ addClips })
  })

  const addAll = () => screen.getByRole('button', { name: /add all/i })

  /** The asset ids handed to the store by the last press. */
  const handedOver = () =>
    (addClips.mock.calls.at(-1)?.[0] as readonly Asset[]).map((added) => added.id)

  it('hands over the whole library oldest first, at the playhead', () => {
    library(asset('third', 'image', 3), asset('second', 'video', 2), asset('first', 'image', 1))

    render(<LibraryPanel currentTime={2.5} />)
    fireEvent.click(addAll())

    expect(handedOver()).toEqual(['first', 'second', 'third'])
    expect(addClips.mock.calls.at(-1)?.[1]).toBe(2.5)
  })

  it('leaves out sound and anything already on the timeline', () => {
    library(asset('still', 'image', 3), asset('music', 'audio', 2), asset('shot', 'video', 1))
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        clips: [{ id: 'clip-1', assetId: 'shot', inPoint: 0, outPoint: 2 }],
      },
    }))

    render(<LibraryPanel currentTime={0} />)
    // The count says what is about to happen before it happens.
    expect(addAll()).toHaveTextContent('Add all (1)')
    fireEvent.click(addAll())

    expect(handedOver()).toEqual(['still'])
  })

  it('has nothing left to do once every shot is on the timeline', () => {
    library(asset('still', 'image', 1))
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        clips: [{ id: 'clip-1', assetId: 'still', inPoint: 0, outPoint: 4 }],
      },
    }))

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
