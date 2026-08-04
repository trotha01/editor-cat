import type { GenerationProgress } from '../lib/falClient'
import { Button, Spinner } from './ui'

/**
 * Live feedback while a job is queued or running.
 *
 * Video generation can take several minutes, and an unexplained frozen button
 * for that long reads as a broken app — so show the queue position, elapsed
 * time, and whatever the provider is saying, and always offer a way out.
 */
export function GenerationStatus({
  progress,
  onCancel,
}: {
  progress: GenerationProgress
  onCancel: () => void
}) {
  const label =
    progress.status === 'IN_QUEUE'
      ? progress.queuePosition && progress.queuePosition > 0
        ? `Queued — position ${progress.queuePosition}`
        : 'Queued at the provider…'
      : 'Generating…'

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center gap-2.5">
        <Spinner className="text-accent" />
        <span className="text-sm font-medium">{label}</span>
        <span className="ml-auto text-xs tabular-nums text-ink-dim">
          {progress.elapsed.toFixed(0)}s
        </span>
      </div>

      {progress.message ? (
        <p className="line-clamp-2 text-xs leading-relaxed text-ink-dim">{progress.message}</p>
      ) : null}

      <p className="text-xs text-ink-dim">
        You can leave this tab open and keep editing — generation continues at the provider.
      </p>

      <Button variant="ghost" className="self-start" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}
