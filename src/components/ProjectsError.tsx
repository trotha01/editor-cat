/**
 * The notice that says the project list never arrived.
 *
 * A strip under the header rather than a badge in it, because the consequence
 * needs a sentence rather than a word. When the list fails at startup nothing
 * gets opened, so the editor comes up on a blank document that is
 * indistinguishable from a new project — and every edit made in it is going
 * nowhere, since the push loop is only armed once a project is open. "Not
 * saved" in the corner is true and tells nobody any of that.
 *
 * The same failure is repeated inside the project menu, where someone who
 * reaches for their projects will look first. Both are worth having: this one
 * finds people who were not looking for it.
 */
import { Button, Callout } from './ui'
import { useProjectsStore } from '../state/useProjectsStore'

export function ProjectsError() {
  const listError = useProjectsStore((state) => state.listError)
  const activeId = useProjectsStore((state) => state.activeId)
  const busy = useProjectsStore((state) => state.busy)
  const reloadProjects = useProjectsStore((state) => state.reloadProjects)

  if (!listError) return null

  return (
    <div className="shrink-0 px-4 pt-3">
      <Callout tone="error" title="Could not load your projects">
        {/* On its own line. Server messages arrive without punctuation — "JWT
            expired" — and run straight into whatever follows them. */}
        <p>{listError}</p>
        <p className="mt-1">
          {/* Only when the failure left nothing open. A refresh that fails with
              a project already on screen has not put that project at risk. */}
          {activeId
            ? 'The project on screen is unaffected — this is the list of the others.'
            : 'Until this succeeds the editor is showing an empty project, and nothing you change here is being saved to your account.'}
          <Button
            variant="ghost"
            className="ml-2 px-1.5 py-0.5 text-xs text-red-800 underline hover:text-red-900"
            disabled={busy}
            onClick={() => void reloadProjects()}
          >
            Try again
          </Button>
        </p>
      </Callout>
    </div>
  )
}
