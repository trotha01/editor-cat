/**
 * Places a floating panel next to the control that opened it.
 *
 * Panels over the timeline are rendered into `document.body` rather than into
 * the lane they belong to, because the timeline scrolls horizontally and a
 * scroll container clips both axes — drawn inside a lane, a panel of any height
 * is cut off at the edge of the track it hangs from. Being in the body costs it
 * the ability to move with its anchor, which is why any scroll dismisses it: a
 * panel that stays behind while its clip slides away is pointing at the wrong
 * thing.
 *
 * So this owns the two parts that go with living in the body — where to put it,
 * and when it has stopped being about anything — and leaves focus and contents
 * to whatever is using it, since a menu and a picker want different things
 * there.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Gap between the control and its panel, and the margin the panel keeps from the edge. */
const OFFSET = 4
const MARGIN = 8

export interface AnchoredPanel<A extends HTMLElement, P extends HTMLElement> {
  /** Goes on the control that opens the panel. */
  anchorRef: RefObject<A | null>
  /** Goes on the panel itself. */
  panelRef: RefObject<P | null>
  /**
   * Where to draw it, or null until it has been measured — a panel rendered
   * before it has been placed flashes at the corner of the screen, so callers
   * hide it for that frame rather than moving it afterwards.
   */
  position: { top: number; left: number } | null
}

export function useAnchoredPanel<A extends HTMLElement, P extends HTMLElement>({
  open,
  align = 'start',
  onDismiss,
}: {
  open: boolean
  /** Whether the panel lines its left edge up with the control or centres on it. */
  align?: 'start' | 'center'
  /** A press outside, a scroll anywhere, or a resize. Must be stable. */
  onDismiss: () => void
}): AnchoredPanel<A, P> {
  const anchorRef = useRef<A>(null)
  const panelRef = useRef<P>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  // Placed once it can be measured: which way it has to flip depends on how
  // tall it turned out, and that is not known until it has been rendered.
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return

    const box = anchor.getBoundingClientRect()
    const { width, height } = panel.getBoundingClientRect()
    const room = { width: window.innerWidth, height: window.innerHeight }

    const below = box.bottom + OFFSET
    const top =
      below + height > room.height - MARGIN ? Math.max(MARGIN, box.top - height - OFFSET) : below
    const wanted = align === 'center' ? box.left + box.width / 2 - width / 2 : box.left
    const left = Math.max(MARGIN, Math.min(wanted, room.width - width - MARGIN))

    setPosition({ top, left })
  }, [open, align])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onDismiss()
    }
    // Capture, so a scroll anywhere between here and the window counts — the
    // lane, the page, or the panel column, all of which can move the anchor.
    const onScroll = () => onDismiss()

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, onDismiss])

  // A closed panel has no position, whatever the last one measured. Reported
  // rather than cleared, so closing does not cost a render — and reopening is
  // remeasured before the browser paints either way, this being a layout effect.
  return { anchorRef, panelRef, position: open ? position : null }
}
