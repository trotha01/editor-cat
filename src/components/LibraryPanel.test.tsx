/**
 * The Library panel showing this project's files and nobody else's.
 *
 * The catalogue behind it is browser-wide, so the panel used to list every file
 * this machine had ever made — a new project opened with a library full of
 * another project's shots. These cover the two halves of what replaced that:
 * what is listed, and what deleting a row actually does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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

const MINE = imageAsset('asset_mine', 'mine.png')
const THEIRS = imageAsset('asset_theirs', 'theirs.png')

beforeEach(() => {
  vi.clearAllMocks()
  listProjects.mockResolvedValue([])
  deleteAsset.mockResolvedValue(undefined)
  useAssetStore.setState({ assets: [MINE, THEIRS], loading: false })
  useProjectStore.setState({ project: { ...emptyProject(), libraryAssetIds: [MINE.id] } })
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
