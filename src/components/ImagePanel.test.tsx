import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Asset } from '../lib/types'

/**
 * The strip of generated images under the Image tab's form.
 *
 * Generating and then having nothing to look at is the complaint this answers,
 * so what these care about is that the picture turns up, that a second
 * generation lands above the first rather than replacing it, and that neither
 * is lost to a glance at another tab.
 */

const run = vi.fn()
const ingestFromUrl = vi.fn()

vi.mock('../lib/falClient', () => ({
  run: (...args: unknown[]) => run(...args) as unknown,
}))

vi.mock('../lib/media', () => ({
  ingestFromUrl: (...args: unknown[]) => ingestFromUrl(...args) as unknown,
}))

// The panel renders real <img> tags, and object URLs need bytes in IndexedDB.
vi.mock('../hooks/useAssetUrl', () => ({
  useAssetUrl: () => 'blob:fake',
}))

const projectState = {
  project: { width: 720, height: 1280 },
  addClip: vi.fn(),
}

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
}))

const { ImagePanel } = await import('./ImagePanel')
const { useAssetStore } = await import('../state/useAssetStore')
const { useImageResultsStore } = await import('../state/useImageResultsStore')

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

/** Types a prompt and presses the generate button. */
function generate(prompt: string) {
  fireEvent.change(screen.getByLabelText(/image prompt/i), { target: { value: prompt } })
  // "Generate image", or "Generate 2 images" once a batch has been asked for.
  fireEvent.click(screen.getByRole('button', { name: /^Generate/ }))
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ images: [{ url: 'https://fal.example/one.png' }] })
  ingestFromUrl.mockImplementation((_url: string, options: { name: string }) =>
    Promise.resolve(imageAsset(`asset_${options.name}`, options.name)),
  )
  useAssetStore.setState({ assets: [], loading: false })
  useImageResultsStore.setState({ ids: [] })
})

describe('the Image tab', () => {
  it('shows the image it generated', async () => {
    render(<ImagePanel />)

    generate('a lighthouse')

    expect(await screen.findByAltText('a lighthouse')).toHaveAttribute('src', 'blob:fake')
  })

  it('keeps earlier images and puts the newest generation on top', async () => {
    render(<ImagePanel />)

    generate('a lighthouse')
    await screen.findByAltText('a lighthouse')
    generate('a harbour')
    await screen.findByAltText('a harbour')

    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual([
      'a harbour',
      'a lighthouse',
    ])
  })

  it('keeps a batch in the order the model returned it', async () => {
    run.mockResolvedValue({
      images: [{ url: 'https://fal.example/1.png' }, { url: 'https://fal.example/2.png' }],
    })

    render(<ImagePanel />)
    fireEvent.change(screen.getByLabelText(/how many/i), { target: { value: '2' } })
    generate('a lighthouse')
    await screen.findByAltText('a lighthouse (1)')

    expect(screen.getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual([
      'a lighthouse (1)',
      'a lighthouse (2)',
    ])
  })

  it('keeps the images after switching away and back to the tab', async () => {
    // The panel unmounts when another tab is picked (see App.tsx), so the
    // results have to live somewhere that switching tabs does not tear down.
    const { unmount } = render(<ImagePanel />)
    generate('a lighthouse')
    await screen.findByAltText('a lighthouse')

    unmount()
    render(<ImagePanel />)

    expect(screen.getByAltText('a lighthouse')).toBeInTheDocument()
  })

  it('drops an image that has been deleted from the library', async () => {
    render(<ImagePanel />)
    generate('a lighthouse')
    await screen.findByAltText('a lighthouse')

    act(() => useAssetStore.setState({ assets: [] }))

    expect(screen.queryByAltText('a lighthouse')).not.toBeInTheDocument()
  })

  it('adds the image it is shown against to the timeline', async () => {
    render(<ImagePanel />)
    generate('a lighthouse')
    await screen.findByAltText('a lighthouse')

    fireEvent.click(screen.getByRole('button', { name: 'Add to timeline' }))

    expect(projectState.addClip).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a lighthouse' }),
    )
  })
})
