import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
type RenderOptions = Parameters<typeof import('../lib/export/timelineRender').renderTimeline>[0]
const renderTimeline = vi.fn<(options: RenderOptions) => Promise<Blob>>()

vi.mock('../lib/export/timelineRender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/export/timelineRender')>()
  // The plan is the shipped one — the dialog's summary is derived from it — but
  // nothing here is going to run ffmpeg. The options go through: what the dialog
  // asks for is half of what these tests are about.
  return { ...actual, renderTimeline: (options: RenderOptions) => renderTimeline(options) }
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
 * Exporting part of the timeline instead of all of it.
 *
 * What matters here is the default and the refusals. The default is the whole
 * video — an export nobody has touched has to be the one they have been
 * watching — and it is expressed as *no* range at all, which is what keeps the
 * encoder and the Mintspace fingerprint behaving as they always did. The
 * refusals matter because the alternative is silently clamping: a box reading
 * 9 on a four-second project that quietly exports four seconds is worse than
 * one that says so.
 */
describe('choosing a start and an end', () => {
  it('starts on the whole video, and asks for no range at all', async () => {
    open()

    expect(screen.getByLabelText(/start/i)).toHaveValue(0)
    expect(screen.getByLabelText(/end/i)).toHaveValue(4)

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalled())
    expect(renderTimeline).toHaveBeenCalledWith(expect.objectContaining({ range: undefined }))
  })

  it('exports only the stretch that was asked for', async () => {
    open()

    fireEvent.change(screen.getByLabelText(/start/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalled())
    expect(renderTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ range: { start: 1, end: 3 } }),
    )
  })

  it('says how long the export runs, and what it is a part of', () => {
    open()
    expect(screen.getByText(/0:04\.0/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '3' } })

    expect(screen.getByText(/0:03\.0 of 0:04\.0/)).toBeInTheDocument()
  })

  it('refuses an end past the end of the project rather than clamping it', () => {
    open()

    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '9' } })

    expect(screen.getByText(/runs 0:04\.0/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download mp4/i })).toBeDisabled()
  })

  it('refuses an end that comes before its start', () => {
    open()

    fireEvent.change(screen.getByLabelText(/start/i), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '1' } })

    expect(screen.getByText(/end has to come after the start/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download mp4/i })).toBeDisabled()
  })

  it('puts the whole video back, including from a range that does not add up', () => {
    open()

    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /whole video/i }))

    expect(screen.getByLabelText(/start/i)).toHaveValue(0)
    expect(screen.getByLabelText(/end/i)).toHaveValue(4)
    expect(screen.queryByText(/runs 0:04\.0/i)).not.toBeInTheDocument()
  })

  it('encodes again once the range no longer describes what is on hand', async () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))
    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /download mp4/i }))

    await waitFor(() => expect(renderTimeline).toHaveBeenCalledTimes(2))
  })

  it('says nothing about the range on a timeline with nothing on it', () => {
    // Both boxes read zero there, which is a range naming no video — but "add
    // at least one clip" is already on screen and is the only thing to do.
    useProjectStore.setState({ project: emptyProject() })
    open()

    expect(screen.getByText(/add at least one clip/i)).toBeInTheDocument()
    expect(screen.queryByText(/end has to come after the start/i)).not.toBeInTheDocument()
  })

  it('goes back to the whole video when the timeline changes length', () => {
    // "Up to three seconds" was chosen against a four-second edit. On a
    // six-second one it is a range nobody asked for, and the honest default is
    // the whole of what is now there.
    open()
    fireEvent.change(screen.getByLabelText(/end/i), { target: { value: '3' } })

    act(() => {
      useProjectStore.setState({
        project: { ...useProjectStore.getState().project, clips: [CLIP, { ...CLIP, id: 'c2' }] },
      })
    })

    expect(screen.getByLabelText(/end/i)).toHaveValue(8)
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
