/**
 * What captioning a single clip is doing, reported next to the timeline.
 *
 * It belongs here rather than in the Captions step because that is where the
 * press happened: a run started from a clip's menu has to report where the user
 * is looking, and they are looking at the timeline — quite possibly with the
 * Image step open in the panel beside it.
 *
 * The outcome stays until it is dismissed. Transcribing takes long enough to
 * look away from, and "8 captions, replacing 7" is the only confirmation that
 * the words on the lane are the new ones.
 */
import { Button, Callout, Spinner } from './ui'
import { TRANSCRIBE_ATTEMPTS } from '../lib/scribe'
import { useCaptionJobStore } from '../state/useCaptionJobStore'

export function CaptionJobStatus() {
  const clipId = useCaptionJobStore((state) => state.clipId)
  const label = useCaptionJobStore((state) => state.label)
  const progress = useCaptionJobStore((state) => state.progress)
  const outcome = useCaptionJobStore((state) => state.outcome)
  const cancel = useCaptionJobStore((state) => state.cancel)
  const dismiss = useCaptionJobStore((state) => state.dismiss)

  if (clipId === null && !outcome) return null

  if (clipId !== null) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink-dim">
        <Spinner className="!size-3.5 border" />
        <span className="min-w-0 truncate">
          Transcribing {label}
          {progress?.detail ? ` · ${progress.detail}` : ''}
        </span>
        {/* Outside the truncating span, so the one part of this line that says
            the job is waiting rather than stuck cannot be the part a long clip
            name cuts off. */}
        {progress?.attempt ? (
          <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-800">
            retrying ({progress.attempt} of {TRANSCRIBE_ATTEMPTS})
          </span>
        ) : null}
        {/* The one part with a real total is the model download, and it is also
            the long silent wait, so it gets a bar of its own. */}
        {progress?.ratio === undefined ? null : (
          <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full bg-accent transition-[width]"
              style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </span>
        )}
        <Button variant="ghost" className="ml-auto shrink-0 !px-2 !py-0.5" onClick={cancel}>
          Cancel
        </Button>
      </div>
    )
  }

  if (!outcome) return null

  return (
    <Callout tone={outcome.tone}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p>{outcome.text}</p>
          {outcome.detail ? <p className="mt-0.5 text-xs">{outcome.detail}</p> : null}
        </div>
        <Button
          variant="ghost"
          className="shrink-0 !px-2 !py-0.5 text-xs"
          onClick={dismiss}
          aria-label={`Dismiss the captioning result for ${outcome.label}`}
        >
          Dismiss
        </Button>
      </div>
    </Callout>
  )
}
