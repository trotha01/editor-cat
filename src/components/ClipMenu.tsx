/**
 * The ⋯ menu on a clip.
 *
 * Everything a clip can be told to do that is not a drag: captioning it,
 * silencing it, taking it off the timeline. They collect here rather than
 * becoming more buttons in the corner because a clip is only as wide as it is
 * long — a three-second clip has room for about one icon, and putting the third
 * one there would mean the first two could no longer be hit.
 *
 * The menu is rendered into `document.body` rather than into the clip, for the
 * reasons `useAnchoredPanel` explains — it owns where the menu goes and when it
 * stops being about anything, leaving this file the contents and the keyboard.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPanel } from '../hooks/useAnchoredPanel'
import { Spinner } from './ui'
import type { ClipMenuItem } from './clipMenuItems'

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

  // Dismissing and closing differ only in where the focus lands: a press
  // somewhere else has already put it there, and pulling it back would fight
  // whatever the user just reached for.
  const dismiss = useCallback(() => setOpen(false), [])
  const {
    anchorRef: buttonRef,
    panelRef: menuRef,
    position,
  } = useAnchoredPanel<HTMLButtonElement, HTMLDivElement>({ open, onDismiss: dismiss })

  const close = useCallback(() => {
    setOpen(false)
    buttonRef.current?.focus()
  }, [buttonRef])

  // Focus lands on the menu itself rather than the first item: the first item is
  // often the expensive one, and a menu that opens with "spend money" under the
  // return key is a menu that spends money by accident.
  useEffect(() => {
    if (open) menuRef.current?.focus()
  }, [open, menuRef])

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
