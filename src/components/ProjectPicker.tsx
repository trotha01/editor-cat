/**
 * The project name, and the menu for switching between projects.
 *
 * The name is a label here, not a field — renaming lives in Settings now, so
 * clicking it does the same thing clicking anywhere else on this control
 * does: open the switcher. Signed out (or with no Supabase project
 * configured) there is exactly one project and nothing to switch to, so it
 * collapses to a plain, unclickable label.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Spinner } from './ui'
import { folderUrl } from '../lib/google/drive'
import { useDriveStore } from '../state/useDriveStore'
import { useProjectStore } from '../state/useProjectStore'
import { useProjectsStore } from '../state/useProjectsStore'

export function ProjectPicker() {
  const name = useProjectStore((state) => state.project.name)
  const driveFolderId = useProjectStore((state) => state.project.driveFolderId)

  const driveStatus = useDriveStore((state) => state.status)
  const driveParent = useDriveStore((state) => state.folder)

  const status = useProjectsStore((state) => state.status)
  const projects = useProjectsStore((state) => state.projects)
  const activeId = useProjectsStore((state) => state.activeId)
  const busy = useProjectsStore((state) => state.busy)
  const openProject = useProjectsStore((state) => state.openProject)
  const newProject = useProjectsStore((state) => state.newProject)
  const removeProject = useProjectsStore((state) => state.removeProject)

  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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

  if (status === 'local') {
    return (
      <span className="min-w-0 flex-1 truncate px-2 py-1 text-sm" title={name}>
        {name || 'Untitled project'}
      </span>
    )
  }

  return (
    <div className="relative flex min-w-0 flex-1 items-center" ref={menuRef}>
      <Button
        variant="ghost"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch project"
        className="min-w-0 flex-1 justify-start gap-1.5 truncate px-2 py-1 text-sm font-normal"
      >
        <span className="min-w-0 flex-1 truncate text-left">{name || 'Untitled project'}</span>
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
          </div>

          {/*
            Where this project's media is going. Shown here rather than in
            Settings because it is a fact about the open project, not about the
            account — and because the answer differs per project: one made before
            projects had folders of their own still saves into the chosen folder,
            and saying so is better than letting someone hunt for a folder that
            was never made.
          */}
          {driveStatus === 'connected' && driveParent ? (
            <div className="border-t border-line px-2.5 pt-2 pb-1 text-xs text-ink-dim">
              {driveFolderId ? (
                <a
                  href={folderUrl(driveFolderId)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-ink"
                >
                  <span aria-hidden>📁</span> This project’s Drive folder
                </a>
              ) : (
                <span className="block truncate">
                  <span aria-hidden>📁</span> Saving into {driveParent.name}
                </span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
