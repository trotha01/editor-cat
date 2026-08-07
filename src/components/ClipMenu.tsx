/**
 * The ⋯ menu on a clip.
 *
 * Everything a clip can be told to do that is not a drag: captioning it,
 * silencing it, taking it off the timeline. They collect here rather than
 * becoming more buttons in the corner because a clip is only as wide as it is
 * long — a three-second clip has room for about one icon, and putting the third
 * one there would mean the first two could no longer be hit.
 *
 * The menu is rendered into `document.body` rather than into the clip. The
 * timeline scrolls horizontally, and a scroll container clips both axes: drawn
 * inside the lane, a menu of any height would be cut off at the edge of the
 * track it belongs to. Being in the body costs it the ability to move with the
 * clip, which is why any scroll closes it — a menu that stays behind while its
 * clip slides away is pointing at the wrong thing.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Spinner } from './ui'
import type { ClipMenuItem } from './clipMenuItems'

/** Gap between the clip and its menu, and the margin the menu keeps from the edge. */
const OFFSET = 4
const MARGIN = 8

export function ClipMenu({
  label,
  items,
  busy = false,
  className = '',
}: {
  /** What this menu is for, which is what a screen reader announces. */
  label: string
  items: readonly ClipMenuItem[]
  /** Shows a spinner in place of the ⋯, for work this clip started. */
  busy?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  const close = useCallback((focusButton = true) => {
    setOpen(false)
    setPosition(null)
    if (focusButton) buttonRef.current?.focus()
  }, [])

  // Placed once it can be measured: which way it has to flip depends on how
  // tall it turned out, and that is not known until it has been rendered.
  useLayoutEffect(() => {
    if (!open) return
    const button = buttonRef.current
    const menu = menuRef.current
    if (!button || !menu) return

    const anchor = button.getBoundingClientRect()
    const { width, height } = menu.getBoundingClientRect()
    const room = { width: window.innerWidth, height: window.innerHeight }

    const below = anchor.bottom + OFFSET
    const top =
      below + height > room.height - MARGIN ? Math.max(MARGIN, anchor.top - height - OFFSET) : below
    const left = Math.max(MARGIN, Math.min(anchor.left, room.width - width - MARGIN))

    setPosition({ top, left })
    // Focus lands on the menu itself rather than the first item: the first item
    // is often the expensive one, and a menu that opens with "spend money" under
    // the return key is a menu that spends money by accident.
    menu.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      close(false)
    }
    // Capture, so a scroll anywhere between here and the window counts — the
    // lane, the page, or the panel column, all of which can move this clip.
    const onScroll = () => close(false)

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, close])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    if (buttons.length === 0) return
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    // Wraps, and an unfocused menu enters at whichever end you arrived from.
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${label}`}
        title={`Actions for ${label}`}
        // The clip underneath is a drag handle in both lanes, so the press that
        // opens this must not also be the press that starts moving the clip.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((was) => !was)
        }}
        className={`flex items-center justify-center rounded ${className}`}
      >
        {busy ? <Spinner className="!size-3 border" /> : <span aria-hidden>⋯</span>}
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={`Actions for ${label}`}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                // Invisible until placed, or it flashes at the corner of the
                // screen for the frame between rendering and being measured.
                visibility: position ? 'visible' : 'hidden',
              }}
              className="fixed z-50 min-w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm shadow-xl outline-none"
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    close()
                    item.onSelect()
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
                    item.danger ? 'text-red-700 hover:bg-red-500/10' : 'text-ink hover:bg-surface-2'
                  }`}
                >
                  {item.icon ? (
                    <span aria-hidden className="w-4 shrink-0 text-center">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.note ? (
                    <span className="shrink-0 text-xs text-ink-dim">{item.note}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
