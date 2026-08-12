/**
 * What the Captions step asks for before it will transcribe: nothing.
 *
 * The panel used to open on a card of setup — a language to pick, a paragraph
 * about the provider, a warning about redoing — above the transcript that is the
 * actual work. All of it is gone, and it is the kind of thing that grows back
 * one control at a time, so the absences are asserted here rather than left to
 * be noticed.
 *
 * The numbers beside the two sliders are asserted for the opposite reason: a
 * slider's value is invisible in the DOM as well as on screen, so a readout that
 * silently stopped rendering would look exactly like one that never did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CaptionsPanel } from './CaptionsPanel'
import { useAssetStore } from '../state/useAssetStore'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import type { Asset } from '../lib/types'

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const ASSET: Asset = {
  id: 'asset-a',
  kind: 'video',
  blobKey: 'blob-a',
  mimeType: 'video/mp4',
  name: 'take-1.mp4',
  duration: 60,
  createdAt: 0,
}

/** A timeline with a video clip on it, which is what gives the button something to price. */
function mount() {
  useAssetStore.setState({ assets: [ASSET], loading: false })
  useProjectStore.setState({
    project: {
      ...emptyProject(),
      clips: [{ id: 'clip-a', assetId: ASSET.id, inPoint: 0, outPoint: 60 }],
    },
    selectedCaption: null,
  })
  useProjectStore.getState().ensureCaptionTrack()
  render(<CaptionsPanel currentTime={0} onSeek={vi.fn()} />)
}

beforeEach(() => {
  mount()
})

describe('before anything is transcribed', () => {
  it('offers the button and what it will cost, and nothing else to fill in', () => {
    expect(screen.getByRole('button', { name: 'Add captions' })).toBeEnabled()
    expect(screen.getByText(/Costs about/)).toBeInTheDocument()

    expect(screen.queryByText('Karaoke captions')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Which language is spoken')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('the Look controls', () => {
  it('print the size and height they are set to', () => {
    // Closed to begin with, so the transcript is not pushed down the page. Its
    // header carries the summary too, hence the loose name.
    const look = screen.getByRole('button', { name: /^Look/ })
    expect(look).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(look)

    const { style } = useProjectStore.getState().project.captionTracks![0]!
    // Half-percent steps, so the size is written to a decimal: 8% and 8.5% are
    // two sizes a whole-percent readout would print the same way.
    expect(screen.getByText(`${(style.fontScale * 100).toFixed(1)}%`)).toBeInTheDocument()
    expect(screen.getByText(`${Math.round(style.position * 100)}%`)).toBeInTheDocument()
  })
})
