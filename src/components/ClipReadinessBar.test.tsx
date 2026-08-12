import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClipReadinessBar } from './ClipReadinessBar'
import { useClipReadiness } from '../state/useClipReadiness'
import type { ClipReadiness } from '../lib/readiness'

/**
 * What one clip's strip actually draws.
 *
 * The bar is read at a glance and never clicked, so what it is worth comes down
 * to two things: the colour, and whether there is anything there to see. Both go
 * wrong in the same place — a clip with nothing loaded — where a hairline of
 * fill says nothing and the wrong colour says something untrue.
 */

function bar(readiness: ClipReadiness) {
  useClipReadiness.setState({ byClip: { clip_1: readiness } })
  render(<ClipReadinessBar clipId="clip_1" />)
  const fill = screen.getByRole('img').firstElementChild
  if (!(fill instanceof HTMLElement)) throw new Error('the bar drew no fill')
  return fill
}

beforeEach(() => {
  useClipReadiness.setState({ byClip: {} })
})

describe('the clip readiness bar', () => {
  it('runs amber across the whole clip while its media is still on its way', () => {
    // The state a project's clips are all in while it is opening. Red here read
    // as a timeline full of lost media rather than one that was merely loading.
    const fill = bar({ state: 'loading', buffered: 0 })

    expect(fill.className).toContain('bg-amber-400')
    expect(fill.style.width).toBe('100%')
  })

  it('runs red across the whole clip once the media is actually gone', () => {
    const fill = bar({ state: 'missing', buffered: 0 })

    expect(fill.className).toContain('bg-red-500')
    expect(fill.style.width).toBe('100%')
  })

  it('draws how far a clip has got once there is progress to draw', () => {
    const fill = bar({ state: 'loading', buffered: 0.4 })

    expect(fill.className).toContain('bg-amber-400')
    expect(fill.style.width).toBe('40%')
  })

  it('says what it is waiting on rather than quoting nought per cent', () => {
    bar({ state: 'loading', buffered: 0 })

    expect(screen.getByRole('img')).toHaveAccessibleName(/media has not arrived yet/)
  })

  it('leaves a clip nothing has been asked of empty', () => {
    // Nothing has been fetched and nothing was meant to be, so there is nothing
    // to report — a full bar of any colour here would be an alarm about nothing.
    const fill = bar({ state: 'idle', buffered: 0 })

    expect(fill.className).toContain('bg-transparent')
    expect(fill.style.width).toBe('0%')
  })
})
