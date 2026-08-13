/**
 * The box a name turns into when you press the pencil beside it.
 *
 * One component rather than two, because the word pages rename four things —
 * tiers, languages, words and the files under them — and the awkward part is the
 * same every time: Enter keeps the change, Escape throws it away, and clicking
 * somewhere else keeps it too, since nobody expects typing to vanish because
 * they looked away. Escape has to win over that last rule, which is the whole
 * reason this is not four inline `<input>`s.
 */
import { useRef, useState } from 'react'
import { TextInput } from './ui'

export function RenameField({
  initial,
  label,
  onCommit,
  onCancel,
  className = '',
}: {
  initial: string
  /** What the box is called, for a screen reader and for a test to find it by. */
  label: string
  /** Given the trimmed name. Never called with the name it started with. */
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
}) {
  const [draft, setDraft] = useState(initial)
  // Set the moment Escape is pressed, and read by the blur that immediately
  // follows it — without this, cancelling would commit on the way out.
  const cancelled = useRef(false)

  const commit = () => {
    if (cancelled.current) return
    const name = draft.trim()
    if (name && name !== initial) onCommit(name)
    onCancel()
  }

  return (
    <form
      className={`flex min-w-0 flex-1 ${className}`}
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <TextInput
        autoFocus
        value={draft}
        aria-label={label}
        className="!px-2 !py-1 text-sm"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          cancelled.current = true
          onCancel()
        }}
        // A rename inside a row that is also a drag handle, a selection and a
        // delete: none of those should hear about the keys or clicks meant for
        // this box.
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      />
    </form>
  )
}
