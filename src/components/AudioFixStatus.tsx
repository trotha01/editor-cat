/**
 * What fixing a clip's audio is doing, reported next to the timeline.
 *
 * Beside the CaptionJobStatus it is modelled on, and for the same reason: the
 * press happened on a clip, so the answer belongs where the user is looking.
 * The stage is worth saying out loud because the first half of the wait is
 * copying a voice, which is slow, silent, and not obviously part of "say this
 * line" until you are told that it is.
 *
 * The outcome stays until it is dismissed. It carries the one thing that cannot
 * be seen from the lane — how the new line's length sits against the clip it is
 * under — and that is the thing worth acting on before moving away.
 */
import { Button, Callout, Spinner } from './ui'
import { useAudioFixStore } from '../state/useAudioFixStore'

export function AudioFixStatus() {
  const clipId = useAudioFixStore((state) => state.clipId)
  const label = useAudioFixStore((state) => state.label)
  const stage = useAudioFixStore((state) => state.stage)
  const outcome = useAudioFixStore((state) => state.outcome)
  const cancel = useAudioFixStore((state) => state.cancel)
  const dismiss = useAudioFixStore((state) => state.dismiss)

  if (clipId === null && !outcome) return null

  if (clipId !== null) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink-dim">
        <Spinner className="!size-3.5 border" />
        <span className="min-w-0 truncate">
          Fixing the audio on {label}
          {stage ? ` · ${stage}` : ''}
        </span>
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
          aria-label={`Dismiss the audio fix result for ${outcome.label}`}
        >
          Dismiss
        </Button>
      </div>
    </Callout>
  )
}
