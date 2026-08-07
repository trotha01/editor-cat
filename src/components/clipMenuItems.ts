/**
 * What goes in a clip's ⋯ menu, and the shape of one entry.
 *
 * Separate from the menu itself so both lanes build the same caption row from
 * the same code — a voice take and a video clip are captioned identically, and
 * an item that said "generate" in one place and "redo" in the other would be
 * describing a difference that does not exist.
 */
import { formatCost, speechCost } from '../lib/models'
import type { CaptionTarget } from '../lib/captionSources'

export interface ClipMenuItem {
  label: string
  /** Shown to the right, dimmed: what it costs, or why it cannot be pressed. */
  note?: string
  icon?: string
  onSelect: () => void
  disabled?: boolean
  /** Set apart in red. For the ones that take something away. */
  danger?: boolean
}

/**
 * "Generate captions for this clip", priced.
 *
 * The price is on the row rather than in a tooltip because this is the one item
 * in either menu that spends money, and the bill lands on whoever deployed the
 * app. It is exact rather than an estimate — Scribe charges by the minute of
 * audio in, and the clip's length is known before the press.
 *
 * Whether it says "generate" or "redo" is the honest difference between the two:
 * a clip that has captions already is going to lose them, where one without is
 * only gaining something.
 */
export function captionClipItem(target: CaptionTarget, onSelect: () => void): ClipMenuItem {
  const { source, captions } = target
  return {
    icon: '💬',
    label: captions > 0 ? 'Redo captions for this clip' : 'Generate captions for this clip',
    note: formatCost(speechCost(source.duration)),
    onSelect,
  }
}
