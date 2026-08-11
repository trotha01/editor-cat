import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedProject, ProjectSummary } from '../lib/supabase/projects'

/**
 * The two ways the project list stops telling the truth.
 *
 * One is a fetch that fails. It used to happen quietly, and quietly is the
 * problem: a failed list leaves `projects` empty and opens nothing, so the
 * editor comes up on a blank document indistinguishable from a new project, the
 * menu opens onto a list of nothing indistinguishable from a new account, and
 * the only hint anywhere is a "Not saved" badge — a sentence about the last
 * edit, not about the request that actually failed.
 *
 * The other is deleting. A timeline is the one thing here that cannot be
 * reconstructed from anywhere else — the media is in Drive and the metadata is
 * on the server, but the arrangement is hours of somebody's decisions — so the
 * delete is a stamp rather than a delete, and the project has to leave the list
 * without leaving the account, and come back where it belongs.
 */
const listProjects = vi.fn<() => Promise<ProjectSummary[]>>()
const listArchivedProjects = vi.fn<() => Promise<ArchivedProject[]>>()
const archiveProject = vi.fn<(id: string) => Promise<string>>()
const restoreProject = vi.fn<(id: string) => Promise<ProjectSummary>>()
const purgeExpiredProjects = vi.fn(async () => {})
const getProject = vi.fn()
const createProject = vi.fn()
const updateProject = vi.fn()

vi.mock('../lib/supabase/projects', () => ({
  listProjects: () => listProjects(),
  listArchivedProjects: () => listArchivedProjects(),
  archiveProject: (id: string) => archiveProject(id),
  restoreProject: (id: string) => restoreProject(id),
  purgeExpiredProjects: () => purgeExpiredProjects(),
  getProject: (id: string) => getProject(id) as unknown,
  createProject: (...args: unknown[]) => createProject(...args) as unknown,
  updateProject: (...args: unknown[]) => updateProject(...args) as unknown,
  ProjectConflictError: class extends Error {},
  fromStored: (stored: { id: string; name: string; doc: object }) => ({
    id: stored.id,
    name: stored.name,
    ...stored.doc,
  }),
  toDoc: (project: object) => project,
}))

const adopt = vi.fn()
const openLocal = vi.fn(async () => {})
const loadLocal = vi.fn(async () => {})
const local = { id: 'default', name: 'Untitled project', clips: [] }

vi.mock('./useProjectStore', () => ({
  LOCAL_PROJECT_ID: 'default',
  emptyProject: (id: string, name: string) => ({ id, name, clips: [] }),
  useProjectStore: {
    getState: () => ({ project: local, adopt, open: openLocal, load: loadLocal }),
    subscribe: () => () => {},
  },
}))

vi.mock('./useAssetStore', () => ({
  useAssetStore: { getState: () => ({ assets: [], load: async () => {} }) },
}))

const deleteLocal = vi.fn<(id: string) => Promise<void>>(async () => {})

vi.mock('./useAuthStore', () => ({ requiresSignIn: () => true }))
vi.mock('../lib/db', () => ({ deleteProject: (id: string) => deleteLocal(id) }))
vi.mock('../lib/media', () => ({ newId: () => 'generated' }))
vi.mock('../lib/audioTracks', () => ({ migrateProject: (project: unknown) => project }))
vi.mock('../lib/sync/hydrate', () => ({ hydrateProject: async () => [] }))

// Stubbed down to the one behaviour any of this depends on: a flush runs the
// pending work now. Left as a no-op, the test below that checks nothing is
// pushed into a just-deleted project could not fail.
vi.mock('../lib/sync/scheduler', () => ({
  createScheduler: (run: () => Promise<void>) => ({
    schedule: () => {},
    flush: async () => {
      await run()
    },
    cancel: () => {},
    pending: () => false,
  }),
}))

const { useProjectsStore } = await import('./useProjectsStore')

const SUMMARY = { id: 'p1', name: 'Cat trailer', updatedAt: '2026-08-09T12:00:00.000Z', version: 3 }
const STORED = { id: 'p1', name: 'Cat trailer', doc: { clips: [] }, schemaVersion: 1, version: 3 }

/** A second project, for everything about deleting one of several. */
const OTHER = { id: 'p2', name: 'Beach reel', updatedAt: '2026-08-01T12:00:00.000Z', version: 1 }

const DELETED_AT = '2026-08-11T09:00:00Z'

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  listProjects.mockResolvedValue([SUMMARY])
  listArchivedProjects.mockResolvedValue([])
  archiveProject.mockResolvedValue(DELETED_AT)
  getProject.mockResolvedValue(STORED)
  useProjectsStore.setState({
    projects: [],
    archived: [],
    activeId: null,
    status: 'idle',
    version: 0,
    error: null,
    listError: null,
    busy: false,
    hydration: null,
  })
})

describe('start, when the list cannot be fetched', () => {
  it('records why, in its own field', async () => {
    // Its own field rather than `error` because they are different sentences.
    // `error` is "your last edit did not save"; this is "we do not know what
    // projects you have", which is what the picker has to be able to say.
    listProjects.mockRejectedValue(new Error('JWT expired'))

    await useProjectsStore.getState().start()

    expect(useProjectsStore.getState().listError).toBe('JWT expired')
  })

  it('opens nothing, rather than an empty project that looks like a new one', async () => {
    listProjects.mockRejectedValue(new Error('JWT expired'))

    await useProjectsStore.getState().start()

    const state = useProjectsStore.getState()
    expect(state.projects).toEqual([])
    expect(state.activeId).toBeNull()
    expect(createProject).not.toHaveBeenCalled()
    expect(getProject).not.toHaveBeenCalled()
  })

  it('still flags the header, since nothing is going to save either', async () => {
    listProjects.mockRejectedValue(new Error('JWT expired'))

    await useProjectsStore.getState().start()

    expect(useProjectsStore.getState().status).toBe('error')
    expect(useProjectsStore.getState().busy).toBe(false)
  })

  it('does not mistake an empty account for a failure', async () => {
    // The two look identical in `projects` and are opposites everywhere else:
    // this one is a first sign-in, and the local document becomes the first
    // cloud project rather than being stranded.
    listProjects.mockResolvedValue([])
    createProject.mockResolvedValue({ ...STORED, updatedAt: SUMMARY.updatedAt })

    await useProjectsStore.getState().start()

    expect(useProjectsStore.getState().listError).toBeNull()
    expect(createProject).toHaveBeenCalled()
  })

  it('leaves nothing behind once a retry succeeds', async () => {
    listProjects.mockRejectedValueOnce(new Error('JWT expired'))
    await useProjectsStore.getState().start()

    await useProjectsStore.getState().reloadProjects()

    const state = useProjectsStore.getState()
    expect(state.listError).toBeNull()
    expect(state.projects).toEqual([SUMMARY])
    expect(state.activeId).toBe('p1')
  })
})

describe('reloadProjects', () => {
  it('does not reopen the project already on screen', async () => {
    // The retry exists to fetch a list, and the document beside it may have
    // been edited since the failure. Re-adopting it from the server would throw
    // those edits away to fix something else entirely.
    await useProjectsStore.getState().start()
    getProject.mockClear()
    adopt.mockClear()

    await useProjectsStore.getState().reloadProjects()

    expect(getProject).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(useProjectsStore.getState().projects).toEqual([SUMMARY])
  })

  it('reports a retry that fails the same way', async () => {
    listProjects.mockRejectedValue(new Error('Failed to fetch'))

    await useProjectsStore.getState().reloadProjects()

    expect(useProjectsStore.getState().listError).toBe('Failed to fetch')
    expect(useProjectsStore.getState().busy).toBe(false)
  })

  it('sweeps the archive on the way in, and not on every retry', async () => {
    // Housekeeping for projects deleted three months ago, and a session starting
    // is the only moment this app is reliably running — but a list that failed
    // and is being asked for again is not a second session.
    await useProjectsStore.getState().start()
    expect(purgeExpiredProjects).toHaveBeenCalledTimes(1)

    await useProjectsStore.getState().reloadProjects()

    expect(purgeExpiredProjects).toHaveBeenCalledTimes(1)
  })
})

describe('archiveProject', () => {
  beforeEach(() => {
    // Neither of them open, so archiving does not go on to swap the editor's
    // contents — that path has a test of its own below.
    useProjectsStore.setState({ projects: [SUMMARY, OTHER], activeId: null })
  })

  it('takes the project out of the list', async () => {
    await useProjectsStore.getState().archiveProject('p1')

    expect(useProjectsStore.getState().projects).toEqual([OTHER])
  })

  it('keeps it, so there is something to restore', async () => {
    await useProjectsStore.getState().archiveProject('p1')

    // Put there without refetching: the way back should be on screen the moment
    // it leaves the list above it.
    expect(useProjectsStore.getState().archived).toEqual([{ ...SUMMARY, deletedAt: DELETED_AT }])
  })

  it('takes the server’s word for when the clock started', async () => {
    archiveProject.mockResolvedValue('2026-01-02T03:04:05Z')

    await useProjectsStore.getState().archiveProject('p1')

    // Not this browser's clock. Ninety days from a machine that is a year slow
    // would be ninety days that had already run out.
    expect(useProjectsStore.getState().archived[0]?.deletedAt).toBe('2026-01-02T03:04:05Z')
  })

  it('drops only this browser’s copy, which the server can replace', async () => {
    await useProjectsStore.getState().archiveProject('p1')

    expect(deleteLocal).toHaveBeenCalledWith('p1')
  })

  it('does not push the open document back into the project it just deleted', async () => {
    // Deleting the project you are looking at swaps the editor to another, and
    // both ways of doing that flush pending edits first. With the deleted one
    // still marked active, that flush writes the open timeline straight back
    // into the thing that was just deleted.
    listProjects.mockResolvedValue([SUMMARY, OTHER])
    await useProjectsStore.getState().start()
    expect(useProjectsStore.getState().activeId).toBe('p1')
    updateProject.mockClear()

    await useProjectsStore.getState().archiveProject('p1')

    expect(updateProject).not.toHaveBeenCalled()
    expect(useProjectsStore.getState().activeId).toBe('p2')
  })

  it('leaves the list alone when the server refuses', async () => {
    archiveProject.mockRejectedValue(new Error('That project no longer exists.'))

    await useProjectsStore.getState().archiveProject('p1')

    // Showing it gone while it is still there would be the worse of the two
    // lies: the user would go looking in the archive for a project that never
    // left the list.
    expect(useProjectsStore.getState().projects).toEqual([SUMMARY, OTHER])
    expect(useProjectsStore.getState().archived).toEqual([])
    expect(useProjectsStore.getState().error).toBe('That project no longer exists.')
  })
})

describe('restoreProject', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [SUMMARY],
      archived: [{ ...OTHER, deletedAt: DELETED_AT }],
    })
  })

  it('puts it back in the list, in the order the list is kept in', async () => {
    restoreProject.mockResolvedValue(OTHER)

    await useProjectsStore.getState().restoreProject('p2')

    // By last edit, not appended: a project last touched on the 1st belongs
    // under one touched on the 9th, wherever it has just come from.
    expect(useProjectsStore.getState().projects).toEqual([SUMMARY, OTHER])
    expect(useProjectsStore.getState().archived).toEqual([])
  })

  it('sorts a recently edited one back to the top', async () => {
    restoreProject.mockResolvedValue({ ...OTHER, updatedAt: '2026-08-10T12:00:00.000Z' })

    await useProjectsStore.getState().restoreProject('p2')

    expect(useProjectsStore.getState().projects.map((entry) => entry.id)).toEqual(['p2', 'p1'])
  })

  it('leaves it in the archive when it cannot be restored', async () => {
    restoreProject.mockRejectedValue(new Error('That project no longer exists.'))

    await useProjectsStore.getState().restoreProject('p2')

    // Purged while the menu was open is the likely way here, and the row should
    // stay put until something says otherwise rather than vanish from both.
    expect(useProjectsStore.getState().archived).toHaveLength(1)
    expect(useProjectsStore.getState().error).toBe('That project no longer exists.')
  })
})

describe('loadArchived', () => {
  it('fetches the deleted projects', async () => {
    listArchivedProjects.mockResolvedValue([{ ...OTHER, deletedAt: DELETED_AT }])

    await useProjectsStore.getState().loadArchived()

    expect(useProjectsStore.getState().archived).toEqual([{ ...OTHER, deletedAt: DELETED_AT }])
  })

  it('says nothing when it cannot be fetched', async () => {
    useProjectsStore.setState({ archived: [{ ...OTHER, deletedAt: DELETED_AT }] })
    listArchivedProjects.mockRejectedValue(new Error('offline'))

    await useProjectsStore.getState().loadArchived()

    // Opening a menu is not asking for this, and an error banner over it would
    // be about something the user did not do.
    expect(useProjectsStore.getState().error).toBeNull()
    expect(useProjectsStore.getState().archived).toHaveLength(1)
  })
})
