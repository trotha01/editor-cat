import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Clip } from '../lib/types'

/**
 * The export dialog, now that a render can go to two places.
 *
 * The claim worth pinning is that they are the *same* render. Downloading an
 * export to check it and then publishing it should cost one encode, not two,
 * and should publish the very bytes that were checked — a second render at
 * identical settings is not quite the same promise. The other half is honesty
 * about the machine: the dialog has always told people their media is never
 * uploaded, and that sentence has to stop being printed the moment the
 * destination is somewhere it goes.
 */

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
  formatBytes: (bytes: number) => `${bytes} B`,
}))

const downloadBlob = vi.fn()
vi.mock('../lib/media', async (importOriginal) => {
  // Only the save-to-disk half is stood in for: jsdom cannot navigate to a
  // blob: URL, and the rest of this module is what names the project's tracks.
  const actual = await importOriginal<typeof import('../lib/media')>()
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloadBlob(blob, name) }
})

const RENDERED = new Blob(['mp4'], { type: 'video/mp4' })
const renderTimeline = vi.fn<() => Promise<Blob>>()

vi.mock('../lib/export/timelineRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export/timelineRender')>()
  // The plan is the shipped one — the dialog's summary is derived from it — but
  // nothing here is going to run ffmpeg.
  return { ...actual, renderTimeline: () => renderTimeline() }
})

// Enough of Mintspace to reach the publish button without a network.
vi.mock('../lib/mintspace/client', () => ({
  isMintspaceConfigured: () => true,
  mintspaceSiteUrl: () => '',
}))

const publishVideo = vi.fn().mockResolvedValue({
  id: 'v1',
  videoUrl: 'https://cdn/v1.mp4',
  storagePath: 'uid-1/v1.mp4',
  siteUrl: '',
})

vi.mock('../lib/mintspace/publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mintspace/publish')>()
  return {
    ...actual,
    currentAccount: () => Promise.resolve({ id: 'uid-1', email: 'a@b.c', username: 'ada' }),
    publishVideo: (request: unknown) => publishVideo(request),
  }
})

const { ExportDialog } = await import('./ExportDialog')
const { emptyProject, useProjectStore } = await import('../state/useProjectStore')
const { useAssetStore } = await import('../state/useAssetStore')

const CLIP: Clip = { id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }

beforeEach(() => {
  vi.clearAllMocks()
  renderTimeline.mockResolvedValue(RENDERED)
  useProjectStore.setState({ project: { ...emptyProject(), clips: [CLIP] } })
  useAssetStore.setState({ assets: [], loading: false })
})

function open() {
  render(<ExportDialog open onClose={() => {}} />)
}

describe('choosing where an export goes', () => {
  it('downloads by default, and says nothing is uploaded', () => {
    open()

    expect(screen.getByRole('button', { name: /download mp4/i })).toBeInTheDocument()
    expect(screen.getByText(/never uploaded/i)).toBeInTheDocument()
  })

  it('offers Mintspace as a destination', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })

    expect(await screen.findByRole('button', { name: /publish to mintspace/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /download mp4/i })).not.toBeInTheDocument()
  })

  it('stops promising the media stays put once it does not', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })

    await screen.findByRole('button', { name: /publish to mintspace/i })
    expect(screen.queryByText(/never uploaded/i)).not.toBeInTheDocument()
    expect(screen.getByText(/never leaves the machine/i)).toBeInTheDocument()
  })
})

describe('the render itself', () => {
  it('publishes the same bytes that were downloaded, without encoding twice', async () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })
    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(publishVideo).toHaveBeenCalled())
    expect(renderTimeline).toHaveBeenCalledTimes(1)
    expect(publishVideo).toHaveBeenCalledWith(expect.objectContaining({ video: RENDERED }))
  })

  it('encodes again once the settings no longer describe what is on hand', async () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))
    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText(/quality/i), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(2))
  })

  it('records what it published on the project, and will not post it twice', async () => {
    open()
    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })
    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))
    await waitFor(() => expect(publishVideo).toHaveBeenCalledTimes(1))

    // On the project document, which is what syncs and what survives a reload.
    const publications = useProjectStore.getState().project.publications ?? []
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({ videoId: 'v1', storagePath: 'uid-1/v1.mp4' })

    // Pressing it again renders the same file, recognises it, and stops.
    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    expect(await screen.findByText(/the one already posted/i)).toBeInTheDocument()
    expect(publishVideo).toHaveBeenCalledTimes(1)
  })

  it('reports a render that failed as a sentence', async () => {
    renderTimeline.mockRejectedValue(new Error('the encoder gave up'))
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    expect(await screen.findByText(/the encoder gave up/i)).toBeInTheDocument()
  })
})
