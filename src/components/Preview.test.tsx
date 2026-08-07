import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Asset, Project } from '../lib/types'

/**
 * Fullscreen on the preview.
 *
 * The thing worth pinning down is *what* fills the screen. The preview is a
 * stack of media elements chased to a clock above them, so handing one `<video>`
 * to the browser would show a single clip, drop the audio layered over it, and
 * leave nothing to press. So these tests care that the whole player goes, and
 * that we never offer a button the browser would only refuse.
 */

const project: Project = {
  id: 'p1',
  name: 'Test',
  clips: [{ id: 'clip_1', assetId: 'asset_1', inPoint: 0, outPoint: 4 }],
  audioTracks: [{ id: 'track_1', kind: 'voice', name: 'Voice 1', muted: false, volume: 1 }],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
}

const asset: Asset = {
  id: 'asset_1',
  kind: 'video',
  blobKey: 'blob_1',
  mimeType: 'video/mp4',
  name: 'A clip',
  duration: 4,
  createdAt: 0,
}

const projectState = { project }
const assetState = { assets: [asset] }

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
}))

vi.mock('../state/useAssetStore', () => ({
  useAssetStore: (selector: (state: typeof assetState) => unknown) => selector(assetState),
}))

vi.mock('../hooks/useAssetUrl', () => ({
  useAssetUrl: () => 'blob:fake',
  useAssetSource: () => ({ url: 'blob:fake', failed: false }),
}))

const { Preview } = await import('./Preview')

/**
 * A fullscreen API faithful enough to test against — jsdom has none at all.
 * The half that matters most is the one we do not drive: the document telling
 * us after the fact which element ended up holding the screen.
 */
let holder: Element | null = null

function setEnabled(enabled: boolean) {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: enabled })
}

function claim(element: Element | null) {
  holder = element
  document.dispatchEvent(new Event('fullscreenchange'))
  return Promise.resolve()
}

function enter(this: Element) {
  return claim(this)
}

function exit() {
  return claim(null)
}

const requestFullscreen = vi.fn(enter)
const exitFullscreen = vi.fn(exit)

beforeEach(() => {
  vi.clearAllMocks()
  requestFullscreen.mockImplementation(enter)
  exitFullscreen.mockImplementation(exit)

  holder = null
  projectState.project = project

  setEnabled(true)
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => holder })
  Element.prototype.requestFullscreen = requestFullscreen
  document.exitFullscreen = exitFullscreen
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mount() {
  return render(
    <Preview currentTime={0} playing={false}>
      <button type="button">Play</button>
    </Preview>,
  )
}

function fullscreenButton() {
  return screen.getByRole('button', { name: /fullscreen/i })
}

describe('the fullscreen button', () => {
  it('is offered once there is something to watch', () => {
    mount()

    expect(fullscreenButton()).toBeInTheDocument()
  })

  it('is not offered for an empty timeline', () => {
    // Nothing to fill a screen with, and the empty state is a call to action
    // rather than something to sit and look at.
    projectState.project = { ...project, clips: [] }

    mount()

    expect(screen.queryByRole('button', { name: /fullscreen/i })).not.toBeInTheDocument()
  })

  it('is not offered where the browser will not allow it', () => {
    // An iframe without allow="fullscreen", or an iPhone, where only a bare
    // <video> can do this. A button that can only fail is worse than none.
    setEnabled(false)

    mount()

    expect(screen.queryByRole('button', { name: /fullscreen/i })).not.toBeInTheDocument()
  })
})

describe('what fills the screen', () => {
  it('is the whole player, not the clip that happens to be playing', () => {
    mount()

    fireEvent.click(fullscreenButton())

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(holder).toBe(screen.getByRole('region', { name: 'Preview' }))
    expect(holder?.querySelector('video')).not.toBeNull()
  })

  it('keeps the transport, so it can still be paused from in there', () => {
    mount()

    fireEvent.click(fullscreenButton())

    expect(holder).toContainElement(screen.getByRole('button', { name: 'Play' }))
  })

  it('keeps the audio elements, which is where a voiceover is coming from', () => {
    projectState.project = {
      ...project,
      audioClips: [
        {
          id: 'audio_1',
          trackId: 'track_1',
          assetId: 'asset_1',
          useConverted: false,
          startTime: 0,
          inPoint: 0,
          duration: 4,
        },
      ],
    }

    mount()
    fireEvent.click(fullscreenButton())

    expect(holder?.querySelector('audio')).not.toBeNull()
  })

  it('comes back out when the button is pressed again', () => {
    mount()

    fireEvent.click(fullscreenButton())
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }))

    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    expect(fullscreenButton()).toHaveAccessibleName('Fullscreen')
  })

  it('follows the browser out, since Escape never reaches us', () => {
    mount()
    fireEvent.click(fullscreenButton())
    expect(fullscreenButton()).toHaveAccessibleName('Exit fullscreen')

    // What the browser does on Escape, or on its own chrome being used.
    act(() => void exit())

    expect(fullscreenButton()).toHaveAccessibleName('Fullscreen')
    expect(exitFullscreen).not.toHaveBeenCalled()
  })
})

describe('the F key', () => {
  it('toggles fullscreen', () => {
    mount()

    fireEvent.keyDown(document.body, { key: 'f' })
    expect(requestFullscreen).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document.body, { key: 'f' })
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way of someone typing a prompt', () => {
    // Otherwise the word "of" alone would throw them in and back out again.
    const view = mount()
    const field = document.createElement('textarea')
    view.container.append(field)

    fireEvent.keyDown(field, { key: 'f' })

    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it("leaves the browser's own Ctrl-F alone", () => {
    mount()

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })

    expect(requestFullscreen).not.toHaveBeenCalled()
  })
})
