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
  setProjectDriveFolder,
  toDoc,
  updateProject,
  type ProjectSummary,
} from '../lib/supabase/projects'
import { deleteProject as deleteLocal } from '../lib/db'
import { createScheduler, type Scheduler } from '../lib/sync/scheduler'
import { hydrateProject, type HydrationProgress } from '../lib/sync/hydrate'
import { createFolder, findFolder, renameFolder } from '../lib/google/drive'
import { migrateProject } from '../lib/audioTracks'
import { newId } from '../lib/media'
import { toDisplayMessage } from '../lib/errors'
import { emptyProject, LOCAL_PROJECT_ID, useProjectStore } from './useProjectStore'
import { useAssetStore } from './useAssetStore'
import { useDriveStore } from './useDriveStore'
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
  busy: boolean
  /** Non-null while media for the open project is being pulled back down. */
  hydration: HydrationProgress | null

  start: () => Promise<void>
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
  /**
   * Writes a project's folder id to the row, and does not care if it fails.
   *
   * The server copy is what the *next* machine reads; this session already has
   * the id in hand. Losing the write costs that machine one lookup by name,
   * which is exactly what `findFolder` is there for — not worth failing a
   * project creation over.
   */
  const recordFolder = (projectId: string, folderId: string) => {
    void setProjectDriveFolder(projectId, folderId).catch(() => {
      // See above: recoverable by name on the other side.
    })
  }

  /** Puts a folder id onto the project list, and onto the open document. */
  const attachFolder = (projectId: string, folderId: string) => {
    set({
      projects: get().projects.map((entry) =>
        entry.id === projectId ? { ...entry, driveFolderId: folderId } : entry,
      ),
    })

    if (useProjectStore.getState().project.id !== projectId) return
    // Installed the way a fetched document is, guard and all. Where a folder
    // turned out to be is a fact from elsewhere rather than an edit, and letting
    // it look like one would schedule a push of a timeline nobody touched. It
    // deliberately does not go through the editor's own persist: the id belongs
    // to the row, and the local cache picks it up from there on the next open.
    applyingRemote = true
    try {
      useProjectStore.setState((state) => ({
        project: { ...state.project, driveFolderId: folderId },
      }))
    } finally {
      applyingRemote = false
    }
  }

  /**
   * The folder ids the other projects have already recorded.
   *
   * Every project is born called "Untitled project", so a folder that matches by
   * name is not thereby this project's. The recorded id is the real link, and one
   * already claimed belongs to whoever claimed it.
   */
  const claimedFolders = (exceptId: string): string[] =>
    get()
      .projects.filter((entry) => entry.id !== exceptId)
      .map((entry) => entry.driveFolderId)
      .filter((id): id is string => Boolean(id))

  /**
   * Makes a new project a folder of its own, named after it.
   *
   * Best-effort from end to end, deliberately: Drive may be unconfigured, never
   * connected, disconnected since, out of quota or simply down, and none of that
   * is a reason to lose a project that already exists on the server. A project
   * with no folder saves into the chosen folder itself — what every project did
   * before this — so a failure here costs tidiness and nothing else.
   *
   * No lookup first. This project was created seconds ago and cannot already
   * have a folder, and creating unconditionally is what keeps two projects
   * sharing the name "Untitled project" from sharing one folder.
   */
  const makeFolderFor = async (projectId: string, name: string): Promise<string | undefined> => {
    const { status, folder } = useDriveStore.getState()
    if (status !== 'connected' || !folder) return undefined

    try {
      const made = await createFolder(name, folder.id)
      recordFolder(projectId, made.id)
      return made.id
    } catch {
      return undefined
    }
  }

  /**
   * Finds the folder a project has but never recorded, without making one.
   *
   * The gap this closes: a folder is created and its id written in a second
   * call, so a create that lands while the record does not — a dropped
   * connection, a 5xx on the way back that `driveFetch` rightly will not
   * retry — leaves a folder nothing points at. Another machine opening that
   * project would otherwise make a second one beside it.
   *
   * It only ever adopts. A project that genuinely has no folder is left without
   * one rather than given one on open: media it uploaded before this feature is
   * sitting in the chosen folder, and a new folder from here on would split one
   * project's media across two places to no one's benefit.
   */
  const adoptFolderFor = (project: Project) => {
    if (project.driveFolderId) return
    const { status, folder } = useDriveStore.getState()
    if (status !== 'connected' || !folder) return

    void findFolder(project.name, folder.id, claimedFolders(project.id))
      .then((found) => {
        if (!found) return
        attachFolder(project.id, found.id)
        recordFolder(project.id, found.id)
      })
      .catch(() => {
        // Nothing is lost by not knowing: uploads go to the chosen folder, the
        // same as they did before projects had folders of their own.
      })
  }

  /**
   * Keeps a project's folder named the same as the project.
   *
   * Hung off the push rather than off `rename`, which fires on every keystroke
   * in the title field — one Drive write per character is not a thing to do to
   * someone's Drive. The push is already debounced to a quiet period, so the
   * name that reaches here is the one they stopped typing on.
   *
   * Best-effort again. A folder that could not be renamed is still the right
   * folder, because uploads go by id; it just reads as the old name in Drive
   * until the next rename lands.
   */
  const syncFolderName = (project: Project, previousName: string | undefined) => {
    const folderId = project.driveFolderId
    if (!folderId || project.name === previousName) return
    if (useDriveStore.getState().status !== 'connected') return

    void renameFolder(folderId, project.name).catch(() => {
      // The name is a label. The id is the link, and it has not moved.
    })
  }

  /** Sends the open project up, guarded by the version we last saw. */
  const push = async () => {
    const { activeId, version } = get()
    if (!activeId) return

    const project = useProjectStore.getState().project
    // Read before the push, because the push is what replaces it: this is the
    // name the folder in Drive was last given.
    const pushedName = get().projects.find((entry) => entry.id === activeId)?.name
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
      syncFolderName(project, pushedName)
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

  return {
    projects: [],
    activeId: null,
    status: requiresSignIn() ? 'idle' : 'local',
    version: 0,
    error: null,
    busy: false,
    hydration: null,

    start: async () => {
      if (!requiresSignIn()) {
        await useProjectStore.getState().load()
        set({ status: 'local' })
        return
      }

      set({ busy: true, error: null })
      try {
        const projects = await listProjects()
        set({ projects })

        if (projects.length === 0) {
          // First sign-in: whatever is already on this machine becomes the
          // user's first cloud project rather than being stranded locally.
          await useProjectStore.getState().open(LOCAL_PROJECT_ID)
          const local = useProjectStore.getState().project
          const created = await createProject(local.name, toDoc(local))
          // Their first cloud project is still a project being created, and gets
          // a folder on the same terms as every one after it.
          const driveFolderId = await makeFolderFor(created.id, created.name)

          apply({ ...fromStored(created), ...(driveFolderId ? { driveFolderId } : {}) })
          rememberActive(created.id)
          set({
            projects: [
              {
                id: created.id,
                name: created.name,
                updatedAt: created.updatedAt,
                version: created.version,
                ...(driveFolderId ? { driveFolderId } : {}),
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
        adoptFolderFor(project)
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
        // The row is the project and it is already safe. The folder is only
        // where its media will go, and nothing about making it — or failing
        // to — can reach back and undo the row.
        const driveFolderId = await makeFolderFor(created.id, created.name)

        apply({ ...fromStored(created), ...(driveFolderId ? { driveFolderId } : {}) })
        rememberActive(created.id)
        set({
          projects: [
            {
              id: created.id,
              name: created.name,
              updatedAt: created.updatedAt,
              version: created.version,
              ...(driveFolderId ? { driveFolderId } : {}),
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
        // The project's folder in Drive stays, media and all. Those are the
        // user's files in the user's own Drive, and deleting a timeline is not
        // an instruction to throw away the footage it was cut from — the whole
        // point of copying it out there was that it survives this app.
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
