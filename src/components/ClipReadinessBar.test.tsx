import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClipReadinessBar } from './ClipReadinessBar'
import { useClipReadiness } from '../state/useClipReadiness'
import type { ClipReadiness } from '../lib/readiness'

/**
 * What colour the bar goes, which is the whole of what it says.
 *
 * Nobody reads a one-pixel strip for its width; they see red and go looking for
 * what has broken. So the states that are merely a wait have to stay off red,
 * and the two that have no progress to draw have to draw something rather than
 * a fill of nothing on a black track.
 */

/** The fill inside the track, which is where the colour and the width live. */
function fill(): HTMLElement {
  return screen.getByRole('img').firstElementChild as HTMLElement
}

function show(readiness: ClipReadiness) {
  useClipReadiness.setState({ byClip: { clip_1: readiness } })
  render(<ClipReadinessBar clipId="clip_1" />)
}

beforeEach(() => {
  useClipReadiness.setState({ byClip: {} })
})

describe('the readiness bar', () => {
  it('is amber, not red, while the clip’s media is still on its way', () => {
    show({ state: 'pending', buffered: 0 })

    expect(fill().className).toContain('bg-amber-400')
    expect(fill().className).not.toContain('bg-red')
  })

  it('fills the whole width for a wait it cannot measure', () => {
    // Nothing is buffered and nothing can be, there being no element yet — and
    // a bar of zero width is a bar nobody can see.
    show({ state: 'pending', buffered: 0 })

    expect(fill().style.width).toBe('100%')
  })

  it('keeps red for media that is actually gone', () => {
    show({ state: 'missing', buffered: 0 })

    expect(fill().className).toContain('bg-red-500')
    expect(fill().style.width).toBe('100%')
  })

  it('draws how far a loading clip has got, because here that is known', () => {
    show({ state: 'loading', buffered: 0.4 })

    expect(fill().style.width).toBe('40%')
  })

  it('says which of the two waits it is, for anyone not looking at the colour', () => {
    show({ state: 'pending', buffered: 0 })

    expect(screen.getByRole('img')).toHaveAccessibleName('Waiting on this clip’s media to arrive')
  })
})
