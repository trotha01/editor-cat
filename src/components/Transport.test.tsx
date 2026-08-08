import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Transport } from './Transport'

/**
 * The transport, and specifically the two things it says about time.
 *
 * Both are wiring rather than arithmetic — `formatTimecode` and `stepFrames`
 * are tested next to themselves in lib/timeline. What is untested there, and
 * what a careless edit would quietly undo, is this component calling them at
 * all: a readout that goes back to tenths of a second, or an arrow key that
 * goes back to moving a tenth, would pass every test in that file.
 */

function mount(props: Partial<Parameters<typeof Transport>[0]> = {}) {
  const onSeek = vi.fn()
  const onToggle = vi.fn()
  render(
    <Transport
      currentTime={0}
      duration={100}
      fps={30}
      playing={false}
      onToggle={onToggle}
      onSeek={onSeek}
      {...props}
    />,
  )
  return { onSeek, onToggle }
}

describe('the time readout', () => {
  it('counts frames after the seconds, not tenths', () => {
    mount({ currentTime: 73.8, duration: 90 })

    // 73.8s at 30fps is 1:13 and frame 24 — not "1:13.8", which names a moment
    // three frames wide that nothing can be cut on.
    expect(screen.getByText(/1:13:24/)).toBeInTheDocument()
  })

  it('counts in the project’s own rate', () => {
    mount({ currentTime: 0.5, duration: 10, fps: 24 })

    expect(screen.getByText(/0:00:12/)).toBeInTheDocument()
  })
})

describe('the arrow keys', () => {
  it('move the playhead exactly one frame', () => {
    const { onSeek } = mount({ currentTime: 1 })

    fireEvent.keyDown(document.body, { key: 'ArrowRight' })

    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(1 + 1 / 30, 9)
  })

  it('go back one frame too', () => {
    const { onSeek } = mount({ currentTime: 1 })

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })

    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(1 - 1 / 30, 9)
  })

  it('cover a second at a time with shift held', () => {
    const { onSeek } = mount({ currentTime: 2 })

    fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true })

    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(3, 9)
  })

  it('step by the project’s frame, not by a fixed one', () => {
    const { onSeek } = mount({ currentTime: 0, fps: 24 })

    fireEvent.keyDown(document.body, { key: 'ArrowRight' })

    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(1 / 24, 9)
  })

  it('stay out of the way of someone typing', () => {
    const { onSeek } = mount()
    const field = document.createElement('input')
    document.body.append(field)

    fireEvent.keyDown(field, { key: 'ArrowRight' })

    expect(onSeek).not.toHaveBeenCalled()
    field.remove()
  })
})
