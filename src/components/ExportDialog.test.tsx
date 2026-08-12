import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const renderTimeline = vi.fn<(options: unknown) => Promise<Blob>>()

vi.mock('../lib/export/timelineRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export/timelineRender')>()
  // The plan is the shipped one — the dialog's summary is derived from it — but
  // nothing here is going to run ffmpeg.
  return { ...actual, renderTimeline: (options: unknown) => renderTimeline(options) }
})

// Enough of Mintspace to reach the publish button without a network.
const configured = { value: true }

vi.mock('../lib/mintspace/client', () => ({
  isMintspaceConfigured: () => configured.value,
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
  window.localStorage.clear()
  configured.value = true
  renderTimeline.mockResolvedValue(RENDERED)
  useProjectStore.setState({ project: { ...emptyProject(), clips: [CLIP] } })
  useAssetStore.setState({ assets: [], loading: false })
})

function open() {
  return render(<ExportDialog open onClose={() => {}} />)
}

/** Closing and reopening the dialog, which is what unmounts the panel. */
function reopen(view: ReturnType<typeof open>) {
  view.rerender(<ExportDialog open={false} onClose={() => {}} />)
  view.rerender(<ExportDialog open onClose={() => {}} />)
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

describe('remembering the settings', () => {
  it('opens on the destination last used', () => {
    open()
    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })

    cleanup()
    open()

    expect(screen.getByLabelText(/export to/i)).toHaveValue('mintspace')
  })

  it('opens on the quality last used', () => {
    open()
    fireEvent.change(screen.getByLabelText(/quality/i), { target: { value: '18' } })

    cleanup()
    open()

    expect(screen.getByLabelText(/quality/i)).toHaveValue('18')
  })

  it('does not remember a destination this deployment cannot reach', () => {
    // A site that has since dropped its Mintspace configuration would otherwise
    // open every export on a panel that can only apologise.
    window.localStorage.setItem('editor-cat.exportDestination.v1', '"mintspace"')
    configured.value = false

    open()

    expect(screen.getByLabelText(/export to/i)).toHaveValue('download')
  })

  it('ignores a remembered quality that is not one of the offered ones', () => {
    window.localStorage.setItem('editor-cat.exportQuality.v1', '99')

    open()

    expect(screen.getByLabelText(/quality/i)).toHaveValue('23')
  })
})

/**
 * Start and end, which are two boxes over the one number that matters: how much
 * of the timeline comes out. The whole of it by default — nobody opening the
 * export dialog to hand someone a video is asking to have part of it withheld —
 * and once narrowed, the same window all the way down to the encoder.
 */
describe('choosing how much of it to export', () => {
  it('offers the whole timeline to start with', () => {
    // The one clip runs four seconds, and nothing has said otherwise.
    open()

    expect(screen.getByLabelText(/^start$/i)).toHaveValue(0)
    expect(screen.getByLabelText(/^end$/i)).toHaveValue(4)
    expect(screen.queryByRole('button', { name: /whole timeline/i })).not.toBeInTheDocument()
  })

  it('renders only the stretch that was asked for', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/^start$/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalled())
    expect(renderTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ range: { start: 1, end: 3 } }),
    )
  })

  it('asks for no range at all when it covers everything', async () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalled())
    expect(renderTimeline).toHaveBeenCalledWith(expect.objectContaining({ range: undefined }))
  })

  it('says how long the file runs, and which part of the timeline it is', () => {
    open()

    fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: '3' } })

    // Three seconds of file, and enough to tell whether the right three.
    expect(screen.getByText(/0:03\.0 · 0:00\.0 to 0:03\.0 of 0:04\.0/)).toBeInTheDocument()
  })

  it('holds a range that reaches past the end of the timeline', () => {
    open()

    fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: '99' } })

    expect(screen.getByLabelText(/^end$/i)).toHaveValue(4)
  })

  it('puts it back to the whole timeline on request', () => {
    open()

    fireEvent.change(screen.getByLabelText(/^start$/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /whole timeline/i }))

    expect(screen.getByLabelText(/^start$/i)).toHaveValue(0)
    expect(screen.getByLabelText(/^end$/i)).toHaveValue(4)
  })

  it('encodes again once the range no longer describes what is on hand', async () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))
    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(2))
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

    // Straight after, it reads as news and says nothing about being already up.
    expect(await screen.findByText('Published')).toBeInTheDocument()
    expect(screen.queryByText(/already in the/i)).not.toBeInTheDocument()

    // And it cannot go again, without being asked and without a second render.
    const button = screen.getByRole('button', { name: /publish to mintspace/i })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(publishVideo).toHaveBeenCalledTimes(1)
  })

  it('turns the confirmation into a record once the dialog has been reopened', async () => {
    const view = open()
    fireEvent.change(screen.getByLabelText(/export to/i), { target: { value: 'mintspace' } })
    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))
    await waitFor(() => expect(publishVideo).toHaveBeenCalledTimes(1))
    await screen.findByText('Published')

    reopen(view)

    expect(await screen.findByText(/already in the mintspace feed/i)).toBeInTheDocument()
    expect(screen.queryByText('Published')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /render and republish/i })).toBeDisabled()
  })

  it('reports a render that failed as a sentence', async () => {
    renderTimeline.mockRejectedValue(new Error('the encoder gave up'))
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    expect(await screen.findByText(/the encoder gave up/i)).toBeInTheDocument()
  })
})
