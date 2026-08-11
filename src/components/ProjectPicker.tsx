/**
 * The project name, and the menu for switching between projects.
 *
 * The name *is* the button. It used to be a text field, which put the two things
 * anyone does with a title — read which project this is, and go to another one —
 * behind an affordance that offered neither: a click landed a caret, and the way
 * to switch was a separate arrow beside it. Renaming is the rarer of the two by
 * a wide margin and has a natural home in Settings, so the header keeps the
 * common one and points at where the other went.
 *
 * Signed out (or with no Supabase project configured) there is exactly one
 * project and nothing to switch between, so this collapses to the plain title it
 * is the rest of the time, without a menu behind it.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Callout, Spinner } from './ui'
import { useProjectStore } from '../state/useProjectStore'
import { useProjectsStore } from '../state/useProjectsStore'

const UNTITLED = 'Untitled project'

export function ProjectPicker({ onOpenSettings }: { onOpenSettings: () => void }) {
  const name = useProjectStore((state) => state.project.name)

  const status = useProjectsStore((state) => state.status)
  const projects = useProjectsStore((state) => state.projects)
  const activeId = useProjectsStore((state) => state.activeId)
  const busy = useProjectsStore((state) => state.busy)
  const listError = useProjectsStore((state) => state.listError)
  const openProject = useProjectsStore((state) => state.openProject)
  const newProject = useProjectsStore((state) => state.newProject)
  const removeProject = useProjectsStore((state) => state.removeProject)
  const reloadProjects = useProjectsStore((state) => state.reloadProjects)

  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // A menu that stays open after clicking away feels broken, and this one sits
  // over the timeline where stray clicks are constant.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Dismissing with the keyboard has to leave focus somewhere deliberate,
      // and the control that opened the menu is the only place that is.
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = name || UNTITLED

  if (status === 'local') {
    return <span className="min-w-0 flex-1 truncate px-2 py-1 text-sm">{label}</span>
  }

  return (
    <div className="relative flex min-w-0 flex-1 items-center" ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch project"
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-sm transition hover:border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="truncate">{label}</span>
        {busy ? (
          <Spinner className="shrink-0" />
        ) : (
          <span aria-hidden className="shrink-0 text-ink-dim">
            ▾
          </span>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl"
        >
          {/* Without this the menu opens onto nothing and reads as an account
              with no projects in it, which is the one thing it is certainly
              not: the list never arrived, so what is here is unknown rather
              than empty. */}
          {listError ? (
            <div className="mb-1">
              <Callout tone="error" title="There was an error getting the projects.">
                {listError}
                <Button
                  variant="ghost"
                  className="mt-1.5 px-1.5 py-0.5 text-xs text-red-800 underline hover:text-red-900"
                  disabled={busy}
                  onClick={() => void reloadProjects()}
                >
                  Try again
                </Button>
              </Callout>
            </div>
          ) : null}

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
                <span className="block truncate">{entry.name || UNTITLED}</span>
                <span className="block text-xs text-ink-dim">
                  {new Date(entry.updatedAt).toLocaleDateString()}
                </span>
              </button>
              <Button
                variant="ghost"
                aria-label={`Delete ${entry.name}`}
                className="shrink-0 px-2 py-1"
                onClick={() => {
                  if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return
                  void removeProject(entry.id)
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
            {/* Renaming moved out of the header when the title became this
                button, so the menu that replaced it says where it went. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
              className="w-full rounded-md px-2.5 py-2 text-left text-sm text-ink-dim hover:bg-surface-2 hover:text-ink"
            >
              <span aria-hidden>✎</span> Rename in Settings
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
