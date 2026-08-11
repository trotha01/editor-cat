/**
 * The cloud project layer: which projects exist, which one is open, and getting
 * edits to the server.
 *
 * `useProjectStore` still owns the open timeline and still writes it to
 * IndexedDB on every mutation — that stays the fast, always-available path.
 * This store sits above it, watching for changes and pushing them to Supabase
 * on a quiet-period debounce.
 */
import { create } from 'zustand'
import {
  createProject,
  deleteProject as deleteRemote,
  getProject,
  listProjects,
  ProjectConflictError,
  fromStored,
  toDoc,
  updateProject,
  type ProjectSummary,
} from '../lib/supabase/projects'
import { deleteProject as deleteLocal } from '../lib/db'
import { createScheduler, type Scheduler } from '../lib/sync/scheduler'
import { hydrateProject, type HydrationProgress } from '../lib/sync/hydrate'
import { migrateProject } from '../lib/audioTracks'
import { newId } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { emptyProject, LOCAL_PROJECT_ID, useProjectStore } from './useProjectStore'
import { useAssetStore } from './useAssetStore'
import { requiresSignIn } from './useAuthStore'
import type { Project } from '../lib/types'

const ACTIVE_KEY = 'editor-cat.project.active.v1'

/** How long editing has to pause before a push goes out. */
const QUIET_PERIOD_MS = 2000

export type SyncStatus =
  /** No account behind this build: IndexedDB is the whole story. */
  'local' | 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

interface ProjectsState {
  projects: ProjectSummary[]
  activeId: string | null
  status: SyncStatus
  /** The server version the open project is based on. */
  version: number
  error: string | null
  /**
   * Why the project list could not be fetched, when it could not.
   *
   * Kept apart from `error` because they are different sentences to whoever is
   * reading them. `error` is "your last edit did not save"; this one is "we do
   * not know what projects you have" — which is worse, and invisible on its
   * own: a failed list leaves `projects` empty, and an empty list is exactly
   * what a brand new account looks like.
   */
  listError: string | null
  busy: boolean
  /** Non-null while media for the open project is being pulled back down. */
  hydration: HydrationProgress | null

  start: () => Promise<void>
  /** Fetches the list again after a failure. Offered wherever one is shown. */
  reloadProjects: () => Promise<void>
  openProject: (id: string) => Promise<void>
  newProject: () => Promise<void>
  removeProject: (id: string) => Promise<void>
  /** Pushes any pending edit immediately. */
  flush: () => Promise<void>
  clearError: () => void
}

function rememberActive(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id)
    else window.localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // Private browsing can refuse storage; the session still works.
  }
}

function lastActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

/**
 * Set while a document fetched from the server is being installed locally.
 *
 * Without it, `adopt` would look exactly like a user edit to the subscription
 * below and immediately schedule a push of what we just received.
 */
let applyingRemote = false

let scheduler: Scheduler | null = null
let unsubscribe: (() => void) | null = null

export const useProjectsStore = create<ProjectsState>((set, get) => {
  /** Sends the open project up, guarded by the version we last saw. */
  const push = async () => {
    const { activeId, version } = get()
    if (!activeId) return

    const project = useProjectStore.getState().project
    set({ status: 'saving' })

    try {
      const saved = await updateProject(activeId, project.name, toDoc(project), version)
      set({
        status: 'saved',
        version: saved.version,
        projects: get().projects.map((entry) =>
          entry.id === saved.id
            ? { ...entry, name: saved.name, updatedAt: saved.updatedAt, version: saved.version }
            : entry,
        ),
      })
    } catch (cause) {
      if (cause instanceof ProjectConflictError) {
        // Deliberately not resolved automatically. Merging two timelines has no
        // sensible answer, and silently picking one loses real work.
        set({ status: 'conflict', error: cause.message })
        return
      }
      set({ status: 'error', error: toDisplayMessage(cause) })
    }
  }

  /** Installs a project into the editor without it counting as an edit. */
  const apply = (project: Project) => {
    applyingRemote = true
    try {
      useProjectStore.getState().adopt(project)
    } finally {
      applyingRemote = false
    }
  }

  /**
   * Fetches whatever media this browser is missing, in the background.
   *
   * Not awaited by the caller: the timeline is already laid out from metadata,
   * so blocking the open on a few hundred megabytes would be pure delay.
   */
  const hydrate = (project: Project) => {
    const known = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]))

    void hydrateProject(project, known, (progress) => {
      set({ hydration: progress.done < progress.total ? progress : null })
    })
      .then(async (restored) => {
        // Reload rather than merge: restored rows are already in IndexedDB, and
        // the store's own loader is the single place that orders the library.
        if (restored.length > 0) await useAssetStore.getState().load()
      })
      .catch((cause: unknown) => {
        set({ hydration: null, error: toDisplayMessage(cause) })
      })
  }

  const watch = () => {
    scheduler ??= createScheduler(push, QUIET_PERIOD_MS)
    unsubscribe ??= useProjectStore.subscribe((state, previous) => {
      if (applyingRemote) return
      if (state.project === previous.project) return
      if (get().status === 'conflict') return // stop writing over a known conflict
      set({ status: 'idle' })
      scheduler?.schedule()
    })
  }

  /**
   * Fetches the list and opens something — everything about startup that talks
   * to the server, and so everything about it that can fail.
   *
   * Split out so the retry offered after a failure takes this exact path rather
   * than a second, subtly different one.
   */
  const load = async () => {
    let projects: ProjectSummary[]
    try {
      projects = await listProjects()
    } catch (cause) {
      // Recorded twice on purpose. `status` is what the header badge reads, and
      // nothing is going to save while this is true; `listError` is what says
      // which thing failed, to a picker that would otherwise just look empty.
      const message = toDisplayMessage(cause)
      set({ status: 'error', error: message, listError: message })
      return
    }

    set({ projects, listError: null })

    // Something is already open, so the list was all that was being fetched.
    // Reopening would throw away whatever has been edited since, and `status`
    // is left alone for the same reason: a refreshed list is not evidence about
    // whether the document on screen has been pushed.
    if (get().activeId) {
      watch()
      return
    }

    if (projects.length === 0) {
      // First sign-in: whatever is already on this machine becomes the
      // user's first cloud project rather than being stranded locally.
      await useProjectStore.getState().open(LOCAL_PROJECT_ID)
      const local = useProjectStore.getState().project
      const created = await createProject(local.name, toDoc(local))

      apply(fromStored(created))
      rememberActive(created.id)
      set({
        projects: [
          {
            id: created.id,
            name: created.name,
            updatedAt: created.updatedAt,
            version: created.version,
          },
        ],
        activeId: created.id,
        version: created.version,
        status: 'saved',
      })
      watch()
      return
    }

    const remembered = lastActive()
    const target = projects.find((entry) => entry.id === remembered) ?? projects[0]
    if (target) await get().openProject(target.id)
    watch()
  }

  return {
    projects: [],
    activeId: null,
    status: requiresSignIn() ? 'idle' : 'local',
    version: 0,
    error: null,
    listError: null,
    busy: false,
    hydration: null,

    start: async () => {
      if (!requiresSignIn()) {
        await useProjectStore.getState().load()
        set({ status: 'local' })
        return
      }

      await get().reloadProjects()
    },

    reloadProjects: async () => {
      set({ busy: true, error: null, listError: null })
      try {
        await load()
      } catch (cause) {
        set({ status: 'error', error: toDisplayMessage(cause) })
      } finally {
        set({ busy: false })
      }
    },

    openProject: async (id) => {
      set({ busy: true, error: null })
      try {
        // Anything still queued belongs to the project being closed, so it has
        // to land before the editor's contents are swapped underneath it.
        await scheduler?.flush()

        const stored = await getProject(id)
        if (!stored) {
          set({ status: 'error', error: 'That project no longer exists.' })
          return
        }

        // Same migration path as local documents, so a project saved before
        // multitrack opens with its layers intact wherever it came from.
        const project = migrateProject(fromStored(stored), newId)

        apply(project)
        rememberActive(id)
        set({ activeId: id, version: stored.version, status: 'saved' })
        watch()
        hydrate(project)
      } catch (cause) {
        set({ status: 'error', error: toDisplayMessage(cause) })
      } finally {
        set({ busy: false })
      }
    },

    newProject: async () => {
      set({ busy: true, error: null })
      try {
        await scheduler?.flush()

        const blank = emptyProject(LOCAL_PROJECT_ID, 'Untitled project')
        const created = await createProject(blank.name, toDoc(blank))

        apply(fromStored(created))
        rememberActive(created.id)
        set({
          projects: [
            {
              id: created.id,
              name: created.name,
              updatedAt: created.updatedAt,
              version: created.version,
            },
            ...get().projects,
          ],
          activeId: created.id,
          version: created.version,
          status: 'saved',
        })
        watch()
      } catch (cause) {
        set({ status: 'error', error: toDisplayMessage(cause) })
      } finally {
        set({ busy: false })
      }
    },

    removeProject: async (id) => {
      set({ busy: true, error: null })
      try {
        if (get().activeId === id) scheduler?.cancel()
        await deleteRemote(id)
        await deleteLocal(id).catch(() => {
          // The local cache is disposable; the server is the record.
        })

        const remaining = get().projects.filter((entry) => entry.id !== id)
        set({ projects: remaining })

        if (get().activeId === id) {
          const next = remaining[0]
          if (next) await get().openProject(next.id)
          else await get().newProject()
        }
      } catch (cause) {
        set({ status: 'error', error: toDisplayMessage(cause) })
      } finally {
        set({ busy: false })
      }
    },

    flush: async () => {
      await scheduler?.flush()
    },

    clearError: () => set({ error: null }),
  }
})

/**
 * Pushes a pending edit when the tab is being hidden or closed.
 *
 * `visibilitychange` is the reliable one — `beforeunload` does not fire on
 * mobile, and a two-second debounce is easily long enough to lose the last
 * edit of a session without this.
 */
export function installFlushOnExit(): () => void {
  const flush = () => {
    if (useProjectsStore.getState().status === 'local') return
    void useProjectsStore.getState().flush()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', flush)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flush)
  }
}
