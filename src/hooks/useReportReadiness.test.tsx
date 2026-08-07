import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { useReportReadiness } from './useReportReadiness'
import { useClipReadiness } from '../state/useClipReadiness'
import type { AssetKind } from '../lib/types'

/**
 * The wiring between a media element and what the timeline draws.
 *
 * The arithmetic is tested next to itself in lib/readiness. What is left here
 * is the part that goes quietly wrong: an element that buffers without telling
 * anyone, a reading that never clears when the clip goes away, or a `progress`
 * event storm turning into a re-render storm.
 */

interface Options {
  kind?: AssetKind | undefined
  url?: string | null
  failed?: boolean
  from?: number
  to?: number
  wanted?: boolean
  warm?: boolean
  imageLoaded?: boolean
  imageBroken?: boolean
}

function Harness({ clipId, options }: { clipId: string; options: Options }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useReportReadiness({
    clipId,
    videoRef,
    kind: 'video',
    url: 'blob:fake',
    failed: false,
    from: 0,
    to: 4,
    wanted: false,
    warm: true,
    imageLoaded: false,
    imageBroken: false,
    ...options,
  })

  return <video ref={videoRef} data-testid="media" />
}

function mount(options: Options = {}, clipId = 'clip_1') {
  return render(<Harness clipId={clipId} options={options} />)
}

/**
 * jsdom has no media pipeline at all, so the two properties the hook reads are
 * stood up by hand. `buffered` is a plain object because `TimeRanges` cannot be
 * constructed, and the hook only ever asks it for `length`, `start` and `end`.
 */
function describeMedia(
  element: HTMLElement,
  { readyState, buffered = [] }: { readyState: number; buffered?: [number, number][] },
) {
  Object.defineProperty(element, 'readyState', { configurable: true, value: readyState })
  Object.defineProperty(element, 'buffered', {
    configurable: true,
    value: {
      length: buffered.length,
      start: (index: number) => buffered[index]?.[0] ?? 0,
      end: (index: number) => buffered[index]?.[1] ?? 0,
    },
  })
}

function readingFor(clipId = 'clip_1') {
  return useClipReadiness.getState().byClip[clipId]
}

beforeEach(() => {
  useClipReadiness.setState({ byClip: {} })
})

describe('reporting what a video element knows', () => {
  it('starts a warmed-up clip at nothing loaded rather than at nothing known', () => {
    mount()

    expect(readingFor()).toEqual({ state: 'loading', buffered: 0 })
  })

  it('leaves a clip outside the warm window idle', () => {
    mount({ warm: false })

    expect(readingFor()).toEqual({ state: 'idle', buffered: 0 })
  })

  it('picks up buffering as the element reports it', () => {
    const view = mount()
    const element = view.getByTestId('media')

    describeMedia(element, { readyState: 2, buffered: [[0, 1]] })
    act(() => void fireEvent(element, new Event('progress')))

    expect(readingFor()).toEqual({ state: 'loading', buffered: 0.25 })
  })

  it('calls a clip ready once the range it uses is covered', () => {
    const view = mount({ from: 10, to: 14 })
    const element = view.getByTestId('media')

    describeMedia(element, { readyState: 4, buffered: [[8, 20]] })
    act(() => void fireEvent(element, new Event('canplaythrough')))

    expect(readingFor()).toEqual({ state: 'ready', buffered: 1 })
  })

  it('does not call a clip ready on buffering that is not its own', () => {
    // The head of a long source, for a clip that starts two minutes in.
    const view = mount({ from: 120, to: 125 })
    const element = view.getByTestId('media')

    describeMedia(element, { readyState: 4, buffered: [[0, 30]] })
    act(() => void fireEvent(element, new Event('progress')))

    expect(readingFor()).toEqual({ state: 'loading', buffered: 0 })
  })

  it('turns starved into stalled the moment the playhead arrives', () => {
    // Nothing on the element fires for this, so it has to be noticed here.
    const view = mount()
    const element = view.getByTestId('media')
    describeMedia(element, { readyState: 1, buffered: [[0, 0.5]] })
    act(() => void fireEvent(element, new Event('waiting')))
    expect(readingFor()?.state).toBe('loading')

    view.rerender(<Harness clipId="clip_1" options={{ wanted: true }} />)

    expect(readingFor()?.state).toBe('stalled')
  })

  it('reports media that could not be resolved as missing', () => {
    mount({ failed: true })

    expect(readingFor()).toEqual({ state: 'missing', buffered: 0 })
  })

  it('reports a clip whose asset is gone from the library as missing', () => {
    mount({ kind: undefined })

    expect(readingFor()).toEqual({ state: 'missing', buffered: 0 })
  })

  it('waits on a source that is still being read out of storage', () => {
    mount({ url: null })

    expect(readingFor()).toEqual({ state: 'loading', buffered: 0 })
  })

  it('forgets a clip that leaves the timeline', () => {
    // Otherwise a removed clip keeps voting in the summary over the picture.
    const view = mount()
    expect(readingFor()).toBeDefined()

    view.unmount()

    expect(readingFor()).toBeUndefined()
  })

  it('ignores progress too small to see, so playback is not re-rendered at it', () => {
    const view = mount()
    const element = view.getByTestId('media')
    describeMedia(element, { readyState: 2, buffered: [[0, 2]] })
    act(() => void fireEvent(element, new Event('progress')))

    const before = readingFor()
    describeMedia(element, { readyState: 2, buffered: [[0, 2.001]] })
    act(() => void fireEvent(element, new Event('progress')))

    // The same object, not merely an equal one: a new one would be a fresh
    // store value and a re-render of every clip card on the timeline.
    expect(readingFor()).toBe(before)
  })
})

describe('reporting a still', () => {
  const still = { kind: 'image' as const }

  it('is loading until the picture has decoded', () => {
    mount({ ...still })

    expect(readingFor()).toEqual({ state: 'loading', buffered: 0 })
  })

  it('is ready once it has, with no buffering to speak of', () => {
    mount({ ...still, imageLoaded: true })

    expect(readingFor()).toEqual({ state: 'ready', buffered: 1 })
  })

  it('is missing when the picture will not decode', () => {
    mount({ ...still, imageBroken: true })

    expect(readingFor()).toEqual({ state: 'missing', buffered: 0 })
  })

  it('is idle rather than loading while it is nowhere near the playhead', () => {
    mount({ ...still, warm: false })

    expect(readingFor()).toEqual({ state: 'idle', buffered: 0 })
  })
})
