import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Timeline } from './Timeline'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectsStore } from '../state/useProjectsStore'

/**
 * The ruler doubles as the scrub bar: it is the only way to move the playhead
 * by dragging rather than nudging it frame by frame. A click alone only ever
 * reports the point you released on — this covers that dragging across it
 * reports every point in between, the way the transport's own scrubber does.
 */

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

beforeEach(() => {
  useProjectStore.setState({ project: emptyProject(), exportRange: null })
  useAssetStore.setState({ assets: [], loading: false })
  useProjectsStore.setState({ hydration: null })
})

function ruler() {
  const region = screen.getByRole('region', { name: 'Timeline' })
  const node = region.querySelector('[role="presentation"]')
  if (!(node instanceof HTMLElement)) throw new Error('ruler not found')
  return node
}

describe('the ruler', () => {
  it('seeks on the initial press, not only on release', () => {
    const onSeek = vi.fn()
    render(<Timeline currentTime={0} onSeek={onSeek} />)

    fireEvent.pointerDown(ruler(), { clientX: 80, pointerId: 1, button: 0 })

    // Zoom starts at 40px/s, so 80px is 2s.
    expect(onSeek).toHaveBeenCalledWith(2)
  })

  it('keeps seeking as the pointer drags across it', () => {
    const onSeek = vi.fn()
    render(<Timeline currentTime={0} onSeek={onSeek} />)

    const bar = ruler()
    fireEvent.pointerDown(bar, { clientX: 40, pointerId: 1, button: 0 })
    fireEvent.pointerMove(bar, { clientX: 120, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientX: 200, pointerId: 1 })

    expect(onSeek.mock.calls.map((call) => call[0])).toEqual([1, 3, 5])
  })

  it('stops once the pointer is released', () => {
    const onSeek = vi.fn()
    render(<Timeline currentTime={0} onSeek={onSeek} />)

    const bar = ruler()
    fireEvent.pointerDown(bar, { clientX: 40, pointerId: 1, button: 0 })
    fireEvent.pointerUp(bar, { clientX: 40, pointerId: 1 })
    onSeek.mockClear()

    fireEvent.pointerMove(bar, { clientX: 200, pointerId: 1 })

    expect(onSeek).not.toHaveBeenCalled()
  })
})

/**
 * A clip whose asset has not shown up in the library yet looks identical
 * whether it is on its way down from Drive or gone for good — the timeline
 * only has the id to go on either way. What tells the two apart is whether a
 * hydration is in flight, so that is what the card has to read.
 */
describe('a clip whose asset is not in the library', () => {
  function projectWithOneClip() {
    return {
      ...emptyProject(),
      clips: [{ id: 'c1', assetId: 'not-yet-known', inPoint: 0, outPoint: 4 }],
    }
  }

  it('says the media is loading while this project is still being restored from Drive', () => {
    useProjectStore.setState({ project: projectWithOneClip() })
    useProjectsStore.setState({ hydration: { done: 1, total: 3, failures: [] } })

    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    expect(screen.getByText('media loading')).toBeInTheDocument()
    expect(screen.queryByText('media missing')).not.toBeInTheDocument()
  })

  it('says the media is missing once nothing is left restoring', () => {
    useProjectStore.setState({ project: projectWithOneClip() })
    useProjectsStore.setState({ hydration: null })

    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    expect(screen.getByText('media missing')).toBeInTheDocument()
    expect(screen.queryByText('media loading')).not.toBeInTheDocument()
  })
})

/**
 * Picture, overlay video and audio clips each carry their own selection, so
 * the Delete key has to check all three rather than only the picture track —
 * this covers each lane once, plus the two ways it must stay out of the way.
 */
describe('the Delete key', () => {
  it('removes the selected picture-track clip', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
      },
      selectedClipId: 'c1',
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
  })

  it('answers to Backspace too', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
      },
      selectedClipId: 'c1',
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Backspace' })

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
  })

  it('removes the selected overlay video clip', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        videoTracks: [{ id: 'vt1', name: 'Layer 1', hidden: false, opacity: 1 }],
        videoClips: [
          { id: 'v1', trackId: 'vt1', assetId: 'a1', startTime: 0, inPoint: 0, duration: 4 },
        ],
      },
      selectedVideoClipId: 'v1',
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(useProjectStore.getState().project.videoClips).toHaveLength(0)
  })

  it('removes the selected audio clip', () => {
    const project = emptyProject()
    useProjectStore.setState({
      project: {
        ...project,
        audioClips: [
          {
            id: 'ac1',
            trackId: project.audioTracks[0]!.id,
            assetId: 'a1',
            useConverted: false,
            startTime: 0,
            inPoint: 0,
            duration: 4,
          },
        ],
      },
      selectedAudioClipId: 'ac1',
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(useProjectStore.getState().project.audioClips).toHaveLength(0)
  })

  it('stays out of the way of someone typing', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
      },
      selectedClipId: 'c1',
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)
    const field = document.createElement('input')
    document.body.append(field)

    fireEvent.keyDown(field, { key: 'Delete' })

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    field.remove()
  })

  it('does nothing when no clip is selected', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
      },
      selectedClipId: null,
      selectedVideoClipId: null,
      selectedAudioClipId: null,
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })
})

/**
 * Marking where an export of the timeline starts and ends — directly here,
 * rather than only by typing seconds into the export dialog, which now opens
 * onto whatever this leaves marked.
 */
describe('marking an export range', () => {
  function projectWithFourSeconds() {
    return {
      ...emptyProject(),
      clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
    }
  }

  it('marks the start at the playhead, and defaults the end to the far end of the timeline', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={1.5} onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))

    expect(useProjectStore.getState().exportRange).toEqual({ start: 1.5, end: 4 })
  })

  it('marks the end at the playhead, and defaults the start to the beginning', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={2.5} onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^end$/i }))

    expect(useProjectStore.getState().exportRange).toEqual({ start: 0, end: 2.5 })
  })

  it('leaves the other edge alone once one has already been marked', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={1} onSeek={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^end$/i }))

    // Both clicked with the playhead still at 1s — "End" reused the start
    // "Start" had just set rather than resetting it to zero.
    expect(useProjectStore.getState().exportRange).toEqual({ start: 1, end: 1 })
  })

  it('answers to the I and O keys', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={3} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 'i' })
    expect(useProjectStore.getState().exportRange).toEqual({ start: 3, end: 4 })

    fireEvent.keyDown(document.body, { key: 'o' })
    expect(useProjectStore.getState().exportRange).toEqual({ start: 3, end: 3 })
  })

  it('stays out of the way of someone typing', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={2} onSeek={vi.fn()} />)
    const field = document.createElement('input')
    document.body.append(field)

    fireEvent.keyDown(field, { key: 'i' })

    expect(useProjectStore.getState().exportRange).toBeNull()
    field.remove()
  })

  it('offers Clear range only once something is marked, and puts the whole video back', () => {
    useProjectStore.setState({ project: projectWithFourSeconds() })
    render(<Timeline currentTime={1} onSeek={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /clear range/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    expect(screen.getByRole('button', { name: /clear range/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /clear range/i }))

    expect(useProjectStore.getState().exportRange).toBeNull()
    expect(screen.queryByRole('button', { name: /clear range/i })).not.toBeInTheDocument()
  })

  it('says what is marked in the header, but only while it cuts something', () => {
    useProjectStore.setState({
      project: projectWithFourSeconds(),
      exportRange: { start: 0, end: 4 },
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    // Fitted back to covering the whole four seconds, which is the same as no
    // range at all — nothing here for the header to say.
    expect(screen.queryByText(/export 0:0/)).not.toBeInTheDocument()

    act(() => {
      useProjectStore.setState({ exportRange: { start: 0, end: 3 } })
    })

    expect(screen.getByText(/export 0:00\.0–0:03\.0/)).toBeInTheDocument()
  })

  it('drags either edge to fine-tune it', () => {
    useProjectStore.setState({
      project: projectWithFourSeconds(),
      exportRange: { start: 1, end: 3 },
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    const start = screen.getByRole('slider', { name: 'Export start' })
    fireEvent.pointerDown(start, { clientX: 40, pointerId: 1, button: 0 })
    fireEvent.pointerMove(start, { clientX: 80, pointerId: 1 })

    // Zoom starts at 40px/s, so a 40px drag is 1s.
    expect(useProjectStore.getState().exportRange).toEqual({ start: 2, end: 3 })

    const end = screen.getByRole('slider', { name: 'Export end' })
    fireEvent.pointerDown(end, { clientX: 120, pointerId: 2, button: 0 })
    fireEvent.pointerMove(end, { clientX: 80, pointerId: 2 })

    expect(useProjectStore.getState().exportRange).toEqual({ start: 2, end: 2 })
  })
})
