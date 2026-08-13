import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Timeline } from './Timeline'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectsStore } from '../state/useProjectsStore'
import { useSettingsStore } from '../state/useSettingsStore'
import type { Asset } from '../lib/types'

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
 * Fixing a clip's pronunciation starts in the clip's own ⋯ menu, and everything
 * about it that can be got wrong is in the wiring: whether the item is there at
 * all, whether it can be pressed without a key, and whether pressing it opens
 * the form for *that* clip. The run itself is covered in `clipAudioFix.test.ts`.
 */
describe('fixing a clip’s audio', () => {
  const video: Asset = {
    id: 'a1',
    kind: 'video',
    blobKey: 'b1',
    mimeType: 'video/mp4',
    name: 'lighthouse.mp4',
    duration: 4,
    createdAt: 0,
  }
  const still: Asset = { ...video, id: 'a2', kind: 'image', name: 'still.png' }

  function timelineWith(assets: Asset[], siteElevenLabs = true) {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: assets.map((asset, index) => ({
          id: `c${index + 1}`,
          assetId: asset.id,
          inPoint: 0,
          outPoint: 4,
        })),
      },
    })
    useAssetStore.setState({ assets, loading: false })
    useSettingsStore.setState({ siteElevenLabs })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)
  }

  it('offers the fix on a clip with sound, and opens the form for that clip', () => {
    timelineWith([video])

    fireEvent.click(screen.getByRole('button', { name: 'Actions for lighthouse.mp4' }))
    const item = screen.getByRole('menuitem', { name: /Fix this clip’s audio/ })
    expect(item).toBeEnabled()

    fireEvent.click(item)

    expect(screen.getByText('Fix the audio on lighthouse.mp4')).toBeInTheDocument()
    expect(screen.getByLabelText('What this clip should say')).toBeInTheDocument()
  })

  it('greys the item out on a deployment with no ElevenLabs key', () => {
    // Nothing the visitor can do about it, which is exactly why the row stays
    // on the menu saying so rather than disappearing.
    timelineWith([video], false)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for lighthouse.mp4' }))

    expect(screen.getByRole('menuitem', { name: /Fix this clip’s audio/ })).toBeDisabled()
  })

  it('says nothing about it on a still, which has no sound to be wrong', () => {
    timelineWith([still])

    fireEvent.click(screen.getByRole('button', { name: 'Actions for still.png' }))

    expect(screen.queryByRole('menuitem', { name: /audio/ })).not.toBeInTheDocument()
  })

  it('calls it a redo once there is a corrected line under the clip already', () => {
    timelineWith([video])
    useProjectStore.getState().addFixedClipAudio('c1', [
      {
        assetId: 'fixed-1',
        useConverted: false,
        startTime: 0,
        inPoint: 0,
        duration: 3,
        label: 'Fixed: lighthouse.mp4',
        speechFix: { text: 'Buongiorno' },
      },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Actions for lighthouse.mp4' }))

    expect(screen.getByRole('menuitem', { name: /Redo this clip’s fixed audio/ })).toBeEnabled()
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
 * Adding a lane is done from the gutter, beside where that lane will turn up,
 * rather than from the row of buttons above the timeline. Which side of the
 * picture each button is on is the whole point of it being there at all, so
 * that is what these cover — a button in the header says nothing about where
 * the track it adds is going to land.
 */
describe('the add-a-track buttons', () => {
  const video: Asset = {
    id: 'a1',
    kind: 'video',
    blobKey: 'b1',
    mimeType: 'video/mp4',
    name: 'lighthouse.mp4',
    duration: 4,
    createdAt: 0,
  }

  /** True when `first` comes before `second` in the rendered document. */
  function precedes(first: Element, second: Element) {
    return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
  }

  it('puts the video button in the gutter, directly above the picture track', () => {
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    const button = screen.getByRole('button', { name: '+ Video track' })

    expect(button.closest('header')).toBeNull()
    expect(precedes(button, screen.getByText('Picture'))).toBe(true)
  })

  it('puts the audio button in the gutter, under the clip sound and over the lanes', () => {
    // A filmed clip, because the clip-sound row is only drawn once there is
    // something on the timeline with sound of its own.
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: video.id, inPoint: 0, outPoint: 4 }],
      },
    })
    useAssetStore.setState({ assets: [video], loading: false })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    const button = screen.getByRole('button', { name: '+ Audio track' })
    const firstLane = useProjectStore.getState().project.audioTracks[0]!

    expect(button.closest('header')).toBeNull()
    expect(precedes(screen.getByText('Clip sound'), button)).toBe(true)
    expect(precedes(button, screen.getByText(firstLane.name))).toBe(true)
  })

  it('adds an empty lane of each kind', () => {
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)
    const audioBefore = useProjectStore.getState().project.audioTracks.length

    fireEvent.click(screen.getByRole('button', { name: '+ Video track' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Audio track' }))

    const project = useProjectStore.getState().project
    expect(project.videoTracks).toHaveLength(1)
    expect(project.audioTracks).toHaveLength(audioBefore + 1)
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
