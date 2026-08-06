/**
 * Progress while media for a freshly opened project comes back from Drive.
 *
 * The timeline is already laid out from metadata by the time this shows, so
 * this explains why a clip might not play yet rather than blocking the editor.
 */
import { Callout } from './ui'
import { useProjectsStore } from '../state/useProjectsStore'

export function HydrationStatus() {
  const hydration = useProjectsStore((state) => state.hydration)
  if (!hydration) return null

  return (
    <Callout tone="info" title="Fetching this project’s media">
      {hydration.done} of {hydration.total} restored from Google Drive. You can arrange the timeline
      now — clips will play as their files arrive.
      {hydration.failures.length > 0 ? (
        <span className="mt-1 block text-amber-800">
          {hydration.failures.length} could not be recovered:{' '}
          {hydration.failures.slice(0, 2).join(', ')}
          {hydration.failures.length > 2 ? '…' : ''}
        </span>
      ) : null}
    </Callout>
  )
}
