/**
 * The project name, and the menu for switching between projects.
 *
 * Signed out (or with no Supabase project configured) there is exactly one
 * project and nothing to switch between, so this collapses to the plain
 * renameable title it was before.
 *
 * Deleting is asked about twice over, because of where it sits: a small button
 * in a scrolling menu, a few pixels from the row that switches projects, and a
 * misfire costs a timeline. It was a `window.confirm` — the browser's dialog,
 * which a page can be told to stop showing, phrased "this cannot be undone" and
 * meaning it. Now it is a dialog of this app's own, saying what actually
 * happens, and the project it names can be brought back for ninety days
 * afterwards from the same menu.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Spinner } from './ui'
import { daysLeft, RETENTION_DAYS, type ProjectSummary } from '../lib/supabase/projects'
import { useProjectStore } from '../state/useProjectStore'
import { useProjectsStore } from '../state/useProjectsStore'

export function ProjectPicker() {
  const name = useProjectStore((state) => state.project.name)
  const rename = useProjectStore((state) => state.rename)

  const status = useProjectsStore((state) => state.status)
  const projects = useProjectsStore((state) => state.projects)
  const archived = useProjectsStore((state) => state.archived)
  const activeId = useProjectsStore((state) => state.activeId)
  const busy = useProjectsStore((state) => state.busy)
  const openProject = useProjectsStore((state) => state.openProject)
  const newProject = useProjectsStore((state) => state.newProject)
  const archiveProject = useProjectsStore((state) => state.archiveProject)
  const restoreProject = useProjectsStore((state) => state.restoreProject)
  const loadArchived = useProjectsStore((state) => state.loadArchived)

  const [open, setOpen] = useState(false)
  /** The project the confirmation is about, or null when nothing is being asked. */
  const [pending, setPending] = useState<ProjectSummary | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Fetched when the menu opens rather than at startup: a session that never
  // deletes anything never needs it, and it is stale by the time it would have
  // been useful anyway.
  useEffect(() => {
    if (open) void loadArchived()
  }, [open, loadArchived])

  // A menu that stays open after clicking away feels broken, and this one sits
  // over the timeline where stray clicks are constant.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const title = (
    <input
      value={name}
      onChange={(event) => rename(event.target.value)}
      aria-label="Project name"
      className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm hover:border-line focus:border-accent focus:outline-none"
    />
  )

  if (status === 'local') return title

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1" ref={menuRef}>
      {title}

      <Button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch project"
        className="shrink-0"
      >
        {busy ? <Spinner /> : <span aria-hidden>▾</span>}
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl"
        >
          {projects.map((entry) => (
            <div key={entry.id} className="flex items-center gap-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  if (entry.id !== activeId) void openProject(entry.id)
                }}
                className={`min-w-0 flex-1 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2 ${
                  entry.id === activeId ? 'font-medium text-ink' : 'text-ink-dim'
                }`}
              >
                <span className="block truncate">{entry.name || 'Untitled project'}</span>
                <span className="block text-xs text-ink-dim">
                  {new Date(entry.updatedAt).toLocaleDateString()}
                </span>
              </button>
              <Button
                variant="ghost"
                aria-label={`Delete ${entry.name}`}
                className="shrink-0 px-2 py-1"
                onClick={() => {
                  // The menu closes with the question open. It is a dropdown
                  // that dismisses itself on any click outside it, and the
                  // dialog is outside it — leaving both up would mean a
                  // confirmation standing in front of a menu that had already
                  // decided to go.
                  setOpen(false)
                  setPending(entry)
                }}
              >
                🗑
              </Button>
            </div>
          ))}

          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void newProject()
              }}
              className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2"
            >
              <span aria-hidden>＋</span> New project
            </button>
          </div>

          {archived.length > 0 ? (
            <ArchivedSection projects={archived} onRestore={restoreProject} />
          ) : null}
        </div>
      ) : null}

      {/* Mounted only while something is being asked. The dialog names a
          specific project, and an unmounted one cannot have that sentence
          sitting in the page about a project nobody picked. */}
      {pending ? (
        <ConfirmDelete
          project={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            void archiveProject(pending.id)
            setPending(null)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * The way back, for the ninety days there is one.
 *
 * At the bottom of the same menu the project was deleted from, which is where
 * someone who has just deleted the wrong one will look. Absent entirely when
 * there is nothing deleted, so the menu does not grow a permanent section about
 * a thing most people never do.
 */
function ArchivedSection({
  projects,
  onRestore,
}: {
  projects: readonly { id: string; name: string; deletedAt: string }[]
  onRestore: (id: string) => Promise<void>
}) {
  return (
    <div className="mt-1 border-t border-line pt-1">
      <p className="px-2.5 py-1 text-xs font-semibold tracking-wide text-ink-dim uppercase">
        Recently deleted
      </p>

      {projects.map((entry) => {
        const left = daysLeft(entry.deletedAt)
        return (
          <div key={entry.id} className="flex items-center gap-1 px-2.5 py-1">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink-dim">
                {entry.name || 'Untitled project'}
              </span>
              <span className="block text-xs text-ink-dim">
                {left === 0
                  ? 'Gone today'
                  : `${left} ${left === 1 ? 'day' : 'days'} left to restore`}
              </span>
            </div>
            <Button
              variant="ghost"
              className="shrink-0 px-2 py-1 text-xs"
              onClick={() => void onRestore(entry.id)}
            >
              Restore
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The question, asked in this app's own words.
 *
 * It names the project, because the button that opens it is an icon in a list of
 * near-identical rows and "are you sure?" is not enough to check against. And it
 * says what deleting actually does now — kept for ninety days, restorable from
 * this menu — rather than the "cannot be undone" this used to warn about, which
 * was true then and would be a lie now.
 */
function ConfirmDelete({
  project,
  onCancel,
  onConfirm,
}: {
  project: ProjectSummary
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open onClose={onCancel} title="Delete this project?">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed">
          <strong className="font-medium">{project.name || 'Untitled project'}</strong> will be
          moved to recently deleted, and this browser will stop keeping a copy of it. You can
          restore it from the project menu for the next {RETENTION_DAYS} days.
        </p>
        <p className="text-xs leading-relaxed text-ink-dim">
          After that it is deleted for good. Media already saved to your Google Drive stays there
          either way — deleting a project does not touch your Drive.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel}>Keep it</Button>
          <Button variant="danger" onClick={onConfirm}>
            Delete project
          </Button>
        </div>
      </div>
    </Modal>
  )
}
