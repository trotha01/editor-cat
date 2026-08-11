import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VideoTrackHeaders, VideoTrackLanes } from './VideoTrackLanes'
import { emptyProject, useProjectStore } from '../state/useProjectStore'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectsStore } from '../state/useProjectsStore'
import { videoTracksOf } from '../lib/videoTracks'

/**
 * Which way up the lane stack is drawn.
 *
 * The array is bottom of the stack first and every part of the timeline draws it
 * reversed, so a control that moves a lane *up the screen* has to move it
 * *later* in the array. Both halves of that are easy to write and neither is
 * visible in a unit test of the reordering itself: swapping the two buttons over
 * leaves `moveVideoTrack` passing and the picture stacking the wrong way round.
 * So this renders the real headers, presses the real button, and reads the order
 * off the DOM — which is top to bottom on screen, the rows being a flex column.
 */

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

/** Three lanes, bottom of the stack first, as the array itself is. */
const lanes = [1, 2, 3].map((n) => ({
  id: `v${n}`,
  name: `Video ${n}`,
  hidden: false,
  opacity: 1,
}))

/** The lane names top to bottom on screen, and then bottom-first in the array. */
const onScreen = () => screen.getAllByTitle(/^Video \d$/).map((node) => node.textContent)
const inArray = () => videoTracksOf(useProjectStore.getState().project).map((track) => track.name)

beforeEach(() => {
  useProjectStore.setState({ project: { ...emptyProject(), videoTracks: lanes, videoClips: [] } })
  useAssetStore.setState({ assets: [], loading: false })
  useProjectsStore.setState({ hydration: null })
})

describe('the lane headers', () => {
  it('draws the top of the stack — the end of the array — at the top', () => {
    render(<VideoTrackHeaders />)

    expect(onScreen()).toEqual(['Video 3', 'Video 2', 'Video 1'])
    expect(inArray()).toEqual(['Video 1', 'Video 2', 'Video 3'])
  })

  it('moves a lane up the screen and later in the array, which is the same move', () => {
    render(<VideoTrackHeaders />)
    fireEvent.click(screen.getByRole('button', { name: 'Move Video 1 up' }))

    // Up one row on screen, and one place later in the array. Reversed controls
    // would send it the other way in both at once and still look self-consistent
    // in an assertion that only checked one of them.
    expect(onScreen()).toEqual(['Video 3', 'Video 1', 'Video 2'])
    expect(inArray()).toEqual(['Video 2', 'Video 1', 'Video 3'])
  })

  it('moves one down the screen and earlier in the array', () => {
    render(<VideoTrackHeaders />)
    fireEvent.click(screen.getByRole('button', { name: 'Move Video 3 down' }))

    expect(onScreen()).toEqual(['Video 2', 'Video 3', 'Video 1'])
    expect(inArray()).toEqual(['Video 1', 'Video 3', 'Video 2'])
  })

  it('offers no way up from the top of the stack, or down from the bottom', () => {
    // The lane at the end it is being pushed towards has nowhere to go, and a
    // control that looks live but does nothing is worse than one that is plainly
    // spent — the reorder itself refuses either way.
    render(<VideoTrackHeaders />)

    expect(screen.getByRole('button', { name: 'Move Video 3 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Video 1 down' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Video 1 up' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move Video 3 down' })).toBeEnabled()
  })
})

/**
 * Same distinction as the picture track: a layer whose asset is not in the
 * library yet is either still coming down from Drive or actually gone, and a
 * hydration in flight is what tells those two apart.
 */
describe('a layer whose asset is not in the library', () => {
  function projectWithOneLayer() {
    return {
      ...emptyProject(),
      videoTracks: lanes.slice(0, 1),
      videoClips: [
        {
          id: 'vc1',
          trackId: 'v1',
          assetId: 'not-yet-known',
          startTime: 0,
          inPoint: 0,
          duration: 4,
        },
      ],
    }
  }

  it('says the layer is loading while this project is still being restored from Drive', () => {
    useProjectStore.setState({ project: projectWithOneLayer() })
    useProjectsStore.setState({ hydration: { done: 1, total: 3, failures: [] } })

    render(<VideoTrackLanes zoom={40} />)

    expect(screen.getByText('media loading')).toBeInTheDocument()
    expect(screen.queryByText('missing media')).not.toBeInTheDocument()
  })

  it('says the layer is missing once nothing is left restoring', () => {
    useProjectStore.setState({ project: projectWithOneLayer() })
    useProjectsStore.setState({ hydration: null })

    render(<VideoTrackLanes zoom={40} />)

    expect(screen.getByText('missing media')).toBeInTheDocument()
    expect(screen.queryByText('media loading')).not.toBeInTheDocument()
  })
})
