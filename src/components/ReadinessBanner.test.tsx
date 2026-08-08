import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ClipReadiness } from '../lib/readiness'
import type { Project } from '../lib/types'

/**
 * What the preview admits to.
 *
 * The point of the banner is to separate "this editor is broken" from "two
 * clips are still coming", so the tests that matter are about when it speaks
 * and when it stays out of the way. A badge that is always there is furniture,
 * and furniture over the picture is worse than nothing.
 */

const project: Project = {
  id: 'p1',
  name: 'Test',
  clips: [
    { id: 'clip_1', assetId: 'asset_1', inPoint: 0, outPoint: 4 },
    { id: 'clip_2', assetId: 'asset_2', inPoint: 0, outPoint: 4 },
    { id: 'clip_3', assetId: 'asset_3', inPoint: 0, outPoint: 4 },
  ],
  audioTracks: [],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
}

const projectState = { project }
const readinessState = { byClip: {} as Record<string, ClipReadiness> }

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
}))

vi.mock('../state/useClipReadiness', () => ({
  useClipReadiness: (selector: (state: typeof readinessState) => unknown) =>
    selector(readinessState),
}))

const { ReadinessBanner } = await import('./ReadinessBanner')

const ready: ClipReadiness = { state: 'ready', buffered: 1 }
const idle: ClipReadiness = { state: 'idle', buffered: 0 }

beforeEach(() => {
  projectState.project = project
  readinessState.byClip = {}
})

function banner() {
  return screen.queryByRole('status')
}

describe('the readiness banner', () => {
  it('says nothing once every clip is loaded', () => {
    readinessState.byClip = { clip_1: ready, clip_2: ready, clip_3: ready }

    render(<ReadinessBanner />)

    expect(banner()).not.toBeInTheDocument()
  })

  it('says nothing about clips we have deliberately not fetched', () => {
    // The far end of a long timeline is always in this state. Reporting it
    // would put a permanent notice over the picture saying nothing is wrong.
    readinessState.byClip = { clip_1: ready, clip_2: idle, clip_3: idle }

    render(<ReadinessBanner />)

    expect(banner()).not.toBeInTheDocument()
  })

  it('counts the clips that are actually still arriving', () => {
    readinessState.byClip = {
      clip_1: ready,
      clip_2: { state: 'loading', buffered: 0.2 },
      clip_3: { state: 'loading', buffered: 0.8 },
    }

    render(<ReadinessBanner />)

    expect(banner()).toHaveTextContent('Loading 2 clips')
  })

  it('explains a frozen picture rather than counting at it', () => {
    // This is the whole feature: the playhead is on a clip that ran out of
    // data, and without this the only evidence is a held frame.
    readinessState.byClip = {
      clip_1: { state: 'stalled', buffered: 0.1 },
      clip_2: { state: 'loading', buffered: 0.5 },
      clip_3: ready,
    }

    render(<ReadinessBanner />)

    expect(banner()).toHaveTextContent(/buffering/i)
    expect(banner()).not.toHaveTextContent(/loading/i)
  })

  it('reports media that will never arrive as its own thing', () => {
    // Waiting is worth doing and this is not, so they must not read the same.
    readinessState.byClip = {
      clip_1: { state: 'missing', buffered: 0 },
      clip_2: ready,
      clip_3: ready,
    }

    render(<ReadinessBanner />)

    expect(banner()).toHaveTextContent('1 clip with no media')
  })

  it('mentions both when some are late and some are gone', () => {
    readinessState.byClip = {
      clip_1: { state: 'missing', buffered: 0 },
      clip_2: { state: 'loading', buffered: 0.5 },
      clip_3: ready,
    }

    render(<ReadinessBanner />)

    expect(banner()).toHaveTextContent('Loading 1 clip')
    expect(banner()).toHaveTextContent('1 clip with no media')
  })

  it('stays away from an empty timeline, which has nothing to load', () => {
    projectState.project = { ...project, clips: [] }

    render(<ReadinessBanner />)

    expect(banner()).not.toBeInTheDocument()
  })
})
