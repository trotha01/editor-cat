/**
 * Horizontal or vertical, for the whole project.
 *
 * Sits directly above the preview because that is the thing whose shape it
 * changes — the feedback is immediate and needs no explaining. It lives outside
 * the tab panels on purpose: it drives the image shape on step 1, the video
 * model's aspect ratio on step 2, and the export frame at the end, so it would
 * be wrong to hide it inside any one of them.
 */
import { dimensionsFor, orientationOf, type Orientation } from '../lib/orientation'
import { useProjectStore } from '../state/useProjectStore'

const OPTIONS: { value: Orientation; label: string; hint: string }[] = [
  { value: 'vertical', label: 'Vertical', hint: '9:16 — phones, Reels, Shorts' },
  { value: 'horizontal', label: 'Horizontal', hint: '16:9 — widescreen' },
]

export function OrientationToggle() {
  const width = useProjectStore((state) => state.project.width)
  const height = useProjectStore((state) => state.project.height)
  const setResolution = useProjectStore((state) => state.setResolution)

  const current = orientationOf(width, height)

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-ink-dim">Orientation</span>
      <div
        role="radiogroup"
        aria-label="Orientation"
        className="flex overflow-hidden rounded-lg border border-line"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === current
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              title={option.hint}
              className={`px-3 py-1.5 text-xs transition-colors ${
                selected ? 'bg-accent text-white' : 'bg-surface text-ink-dim hover:text-ink'
              }`}
              onClick={() => {
                // Re-orienting rather than swapping keeps whichever size tier
                // was chosen in the export dialog, and makes clicking the
                // already-selected option a no-op instead of a flip.
                const next = dimensionsFor(option.value, width, height)
                setResolution(next.width, next.height)
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <span className="text-xs text-ink-dim">
        {width}×{height}
      </span>
    </div>
  )
}
