/**
 * Whether the open project has made it to the server.
 *
 * Deliberately quiet in the normal case: with a debounced auto-save there is no
 * Save button to reassure anyone, so the only states worth drawing attention to
 * are the ones where work is genuinely at risk.
 */
import { Button } from './ui'
import { useProjectsStore } from '../state/useProjectsStore'

export function SyncStatus() {
  const status = useProjectsStore((state) => state.status)
  const error = useProjectsStore((state) => state.error)

  if (status === 'local') return null

  if (status === 'conflict') {
    return (
      <span className="flex items-center gap-2 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-800">
        <span aria-hidden>⚠️</span>
        Changed elsewhere
        <Button
          variant="ghost"
          className="px-1.5 py-0 text-xs underline"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </span>
    )
  }

  if (status === 'error') {
    return (
      <span
        className="rounded-full bg-red-500/15 px-2.5 py-1 text-xs text-red-800"
        title={error ?? undefined}
      >
        <span aria-hidden>⚠️</span> Not saved
      </span>
    )
  }

  return (
    <span className="text-xs text-ink-dim" aria-live="polite">
      {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Unsaved changes'}
    </span>
  )
}
