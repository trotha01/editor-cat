import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Timeline } from './Timeline'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectsStore } from '../state/useProjectsStore'
import { useSettingsStore } from '../state/useSettingsStore'
import type { Asset, Clip } from '../lib/types'

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
  useProjectStore.setState({ project: emptyProject(), exportRange: null, selectedIds: [] })
  useAssetStore.setState({ assets: [], loading: false })
  useProjectsStore.setState({ hydration: null })
})

afterEach(() => {
  vi.restoreAllMocks()
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

/**
 * Cutting, which is one button and one key over two tracks.
 *
 * The thing worth pinning is which of them a press lands on. A music bed is
 * usually laid under the whole piece, so the playhead is over it as often as
 * not — cutting it because somebody meant to cut a shot would be an edit they
 * did not ask for, and the selection is the only thing that says which they
 * meant.
 */
describe('the Cut button', () => {
  const MUSIC = {
    id: 'aclip-1',
    trackId: 'm1',
    assetId: 'song',
    useConverted: false,
    startTime: 0,
    inPoint: 0,
    duration: 30,
    label: 'song.mp3',
  }

  function withMusicUnder(clips: Clip[], selectedAudioClipId: string | null) {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips,
        audioTracks: [{ id: 'm1', kind: 'music', name: 'Music 1', muted: false, volume: 0.5 }],
        audioClips: [MUSIC],
      },
      selectedClipId: null,
      selectedAudioClipId,
    })
  }

  const cutButton = () => screen.getByRole('button', { name: /cut/i })

  it('cuts the selected music, on a stretch of timeline with no picture at all', () => {
    withMusicUnder([], 'aclip-1')
    render(<Timeline currentTime={10} onSeek={vi.fn()} />)

    expect(cutButton()).toBeEnabled()
    fireEvent.click(cutButton())

    expect(
      useProjectStore.getState().project.audioClips.map((clip) => [clip.startTime, clip.duration]),
    ).toEqual([
      [0, 10],
      [10, 20],
    ])
  })

  it('cuts the picture and the audio under it together when nothing is selected', () => {
    withMusicUnder([{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 20 }], null)
    render(<Timeline currentTime={10} onSeek={vi.fn()} />)

    fireEvent.click(cutButton())

    // Nothing named which clip was meant, so both lanes under the playhead
    // take the cut — not just the picture, as a bare press used to mean.
    expect(useProjectStore.getState().project.clips).toHaveLength(2)
    expect(useProjectStore.getState().project.audioClips).toHaveLength(2)
  })

  it('cuts an unselected bed alone, with no picture there to cut', () => {
    withMusicUnder([], null)
    render(<Timeline currentTime={10} onSeek={vi.fn()} />)

    expect(cutButton()).toBeEnabled()
    fireEvent.click(cutButton())

    expect(useProjectStore.getState().project.audioClips).toHaveLength(2)
  })

  it('leaves the picture whole when the cut belongs to the audio', () => {
    withMusicUnder([{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 20 }], 'aclip-1')
    render(<Timeline currentTime={10} onSeek={vi.fn()} />)

    fireEvent.click(cutButton())

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    expect(useProjectStore.getState().project.audioClips).toHaveLength(2)
  })

  it('answers to S, the same as the button', () => {
    withMusicUnder([], 'aclip-1')
    render(<Timeline currentTime={10} onSeek={vi.fn()} />)

    fireEvent.keyDown(document.body, { key: 's' })

    expect(useProjectStore.getState().project.audioClips).toHaveLength(2)
  })

  it('stays disabled where neither track can be cut', () => {
    withMusicUnder([], 'aclip-1')
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    expect(cutButton()).toBeDisabled()
  })
})

/**
 * Which clip "the selected clip" is.
 *
 * Delete and Cut both act on it, and each lane used to remember its own — so a
 * press meant for the piece of music you had just cut in two would take a shot
 * off the picture track instead, because that was still selected from earlier.
 */
describe('the selection across lanes', () => {
  it('gives Delete the audio clip once the audio is what was picked', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
        audioTracks: [{ id: 'm1', kind: 'music', name: 'Music 1', muted: false, volume: 0.5 }],
        audioClips: [
          {
            id: 'aclip-1',
            trackId: 'm1',
            assetId: 'song',
            useConverted: false,
            startTime: 0,
            inPoint: 0,
            duration: 30,
          },
        ],
      },
      selectedClipId: 'c1',
      selectedAudioClipId: null,
    })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    // Through the store, as a click on the chip does, and flushed so the key
    // handler is the one this selection registered.
    act(() => useProjectStore.getState().selectAudioClip('aclip-1'))
    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(useProjectStore.getState().project.audioClips).toHaveLength(0)
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })
})

/**
 * Selecting several clips by dragging a band across the timeline, then moving
 * or deleting them as one.
 *
 * Which clips a band caught is answered from where the cards and chips actually
 * are, so these have to say where that is: jsdom lays nothing out and reports
 * every element as a point at the origin, which would have every band catch
 * everything or nothing. The arithmetic itself is covered in `marquee.test.ts`;
 * what is covered here is the wiring — what a press has to miss to be a band at
 * all, and what the group can then be told to do.
 */
describe('the marquee', () => {
  interface Placed {
    left: number
    top: number
    right: number
    bottom: number
  }

  /** Puts each clip's element where a real layout would have put it. */
  function layOut(boxes: Record<string, Placed>) {
    const rect = (box: Placed) =>
      ({
        ...box,
        width: box.right - box.left,
        height: box.bottom - box.top,
        x: box.left,
        y: box.top,
        toJSON: () => box,
      }) as DOMRect
    const origin: Placed = { left: 0, top: 0, right: 0, bottom: 0 }

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const id = this.dataset.clipId
      return rect((id ? boxes[id] : undefined) ?? origin)
    })
  }

  /** Three shots in a row, with a bed under the first two. */
  function threeShotsAndABed() {
    const project = emptyProject()
    useProjectStore.setState({
      project: {
        ...project,
        clips: [
          { id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 },
          { id: 'c2', assetId: 'a2', inPoint: 0, outPoint: 4 },
          { id: 'c3', assetId: 'a3', inPoint: 0, outPoint: 4 },
        ],
        audioClips: [
          {
            id: 'ac1',
            trackId: project.audioTracks[0]!.id,
            assetId: 'song',
            useConverted: false,
            startTime: 0,
            inPoint: 0,
            duration: 4,
          },
        ],
      },
    })
    layOut({
      c1: { left: 0, top: 0, right: 40, bottom: 20 },
      c2: { left: 40, top: 0, right: 80, bottom: 20 },
      c3: { left: 80, top: 0, right: 120, bottom: 20 },
      ac1: { left: 0, top: 60, right: 40, bottom: 80 },
    })
  }

  /** The column the lanes are drawn in, which is what takes the band's press. */
  function lanes() {
    const node = ruler().parentElement
    if (!node) throw new Error('lanes column not found')
    return node
  }

  function sweep(from: [number, number], to: [number, number]) {
    fireEvent.pointerDown(lanes(), { clientX: from[0], clientY: from[1], pointerId: 1, button: 0 })
    fireEvent.pointerMove(lanes(), { clientX: to[0], clientY: to[1], pointerId: 1 })
    fireEvent.pointerUp(lanes(), { clientX: to[0], clientY: to[1], pointerId: 1 })
  }

  it('gathers every clip the band crossed and leaves the rest alone', () => {
    threeShotsAndABed()
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    sweep([10, 5], [60, 10])

    expect(useProjectStore.getState().selectedIds).toEqual(['c1', 'c2'])
  })

  it('reaches down through the lanes to the audio', () => {
    threeShotsAndABed()
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    sweep([10, 5], [30, 70])

    expect(useProjectStore.getState().selectedIds).toEqual(['c1', 'ac1'])
  })

  it('leaves a press that landed on a clip to that clip', () => {
    threeShotsAndABed()
    useProjectStore.setState({ selectedIds: ['c1', 'c2'] })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)
    const card = document.querySelector('[data-clip-id="c3"]')
    if (!card) throw new Error('card not found')

    // Dragging a card is how a clip is moved, so it must not also start a band
    // that would replace the very group being dragged.
    fireEvent.pointerDown(card, { clientX: 90, clientY: 5, pointerId: 1, button: 0 })
    fireEvent.pointerMove(lanes(), { clientX: 200, clientY: 10, pointerId: 1 })

    expect(useProjectStore.getState().selectedIds).toEqual(['c1', 'c2'])
  })

  it('lets go of everything on a click that never became a band', () => {
    threeShotsAndABed()
    useProjectStore.setState({ selectedIds: ['c1', 'c2'] })
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    sweep([200, 90], [201, 90])

    expect(useProjectStore.getState().selectedIds).toEqual([])
  })

  it('deletes the whole group on Delete, across lanes and in one step', () => {
    threeShotsAndABed()
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    sweep([10, 5], [60, 70])
    fireEvent.keyDown(document.body, { key: 'Delete' })

    const project = useProjectStore.getState().project
    expect(project.clips.map((clip) => clip.id)).toEqual(['c3'])
    expect(project.audioClips).toHaveLength(0)

    act(() => useProjectStore.getState().undo())
    expect(useProjectStore.getState().project.clips).toHaveLength(3)
  })

  it('carries the whole group when one of its shots is dropped elsewhere', () => {
    threeShotsAndABed()
    render(<Timeline currentTime={0} onSeek={vi.fn()} />)

    sweep([10, 5], [60, 10])
    act(() => useProjectStore.getState().moveClips(['c1', 'c2'], 'c3'))

    expect(useProjectStore.getState().project.clips.map((clip) => clip.id)).toEqual([
      'c3',
      'c1',
      'c2',
    ])
  })
})

/**
 * Where the lanes are scrolled to after a zoom.
 *
 * jsdom lays nothing out, so scrollLeft here is whatever the component last
 * wrote rather than something the browser has clamped to the content — which
 * is exactly the number under test.
 */
function lanes() {
  const region = screen.getByRole('region', { name: 'Timeline' })
  const node = region.querySelector('.overflow-x-auto')
  if (!(node instanceof HTMLElement)) throw new Error('scrolling lanes not found')
  Object.defineProperty(node, 'clientWidth', { value: 800, configurable: true })
  return node
}

/**
 * Zooming used to leave the scroll offset alone while the lanes stretched under
 * it, so the playhead slid off the side of a long timeline the moment the
 * slider moved. It zooms around the playhead instead.
 */
describe('the zoom slider', () => {
  it('holds the playhead where it is on screen', () => {
    render(<Timeline currentTime={60} onSeek={vi.fn()} />)
    const view = lanes()
    // 60s at the starting 40px/s is 2400px in, scrolled to sit 300px into the view.
    view.scrollLeft = 2100

    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '80' } })

    // 60s at 80px/s is 4800px in, and it is still 300px into the view.
    expect(view.scrollLeft).toBe(4500)
  })

  it('brings a playhead that has been scrolled out of view back to the middle', () => {
    render(<Timeline currentTime={60} onSeek={vi.fn()} />)
    const view = lanes()
    // Scrolled back to the top of the timeline: the playhead at 2400px is a
    // long way past the right edge of an 800px view.
    view.scrollLeft = 0

    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '80' } })

    expect(view.scrollLeft).toBe(4400)
  })
})
