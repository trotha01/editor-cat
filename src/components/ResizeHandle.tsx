import { useRef } from 'react'

/**
 * A draggable divider between two panels.
 *
 * It does not own or clamp the size itself — the sidebar's width and the
 * player's height each have their own bounds — so this only ever reports how
 * far the pointer, or an arrow key, has moved along its axis. The caller turns
 * that into whatever size it is tracking.
 */
export function ResizeHandle({
  orientation,
  onResize,
  label,
  className = '',
}: {
  orientation: 'horizontal' | 'vertical'
  /** Pixel delta along the resize axis: right for horizontal, down for vertical. */
  onResize: (delta: number) => void
  label: string
  className?: string
}) {
  // The pointer position as of the last move, not the drag's origin — each
  // callback only has to report how far things have moved since it last did,
  // and the caller can clamp every step without this having to know the bounds.
  const lastPosition = useRef<number | null>(null)

  const positionOf = (event: React.PointerEvent) =>
    orientation === 'horizontal' ? event.clientX : event.clientY

  const beginDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    lastPosition.current = positionOf(event)
  }

  const moveDrag = (event: React.PointerEvent) => {
    if (lastPosition.current === null) return
    const position = positionOf(event)
    onResize(position - lastPosition.current)
    lastPosition.current = position
  }

  const endDrag = (event: React.PointerEvent) => {
    if (lastPosition.current === null) return
    lastPosition.current = null
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  const step = 24

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
        const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
        if (event.key === backward) onResize(-step)
        else if (event.key === forward) onResize(step)
        else return
        event.preventDefault()
      }}
      className={`group items-center justify-center focus:outline-none ${
        orientation === 'horizontal' ? 'w-2.5 cursor-ew-resize' : 'h-2.5 cursor-ns-resize'
      } ${className}`}
    >
      <div
        aria-hidden
        className={`rounded-full bg-line transition group-hover:bg-accent group-focus-visible:bg-accent ${
          orientation === 'horizontal' ? 'mx-auto h-full w-1' : 'my-auto h-1 w-full'
        }`}
      />
    </div>
  )
}
