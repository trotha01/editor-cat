import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What happens when the project list does not arrive.
 *
 * It used to happen quietly, and quietly is the problem. A failed list leaves
 * `projects` empty and opens nothing, so the editor comes up on a blank
 * document that is indistinguishable from a new project, the menu opens onto a
 * list of nothing that is indistinguishable from a new account, and the only
 * hint anywhere is a "Not saved" badge — which is a sentence about the last
 * edit, not about the request that actually failed. The store has to be able to
 * say which thing went wrong before anything above it can.
 */
const listProjects = vi.fn<() => Promise<unknown[]>>()
const getProject = vi.fn()
const createProject = vi.fn()

vi.mock('../lib/supabase/projects', () => ({
  listProjects: () => listProjects(),
  getProject: (id: string) => getProject(id) as unknown,
  createProject: (...args: unknown[]) => createProject(...args) as unknown,
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
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

vi.mock('./useAuthStore', () => ({ requiresSignIn: () => true }))
vi.mock('../lib/db', () => ({ deleteProject: async () => {} }))
vi.mock('../lib/media', () => ({ newId: () => 'generated' }))
vi.mock('../lib/audioTracks', () => ({ migrateProject: (project: unknown) => project }))
vi.mock('../lib/sync/hydrate', () => ({ hydrateProject: async () => [] }))
vi.mock('../lib/sync/scheduler', () => ({
  createScheduler: () => ({
    schedule: () => {},
    flush: async () => {},
    cancel: () => {},
    pending: () => false,
  }),
}))

const { useProjectsStore } = await import('./useProjectsStore')

const SUMMARY = { id: 'p1', name: 'Cat trailer', updatedAt: '2026-08-09T12:00:00.000Z', version: 3 }
const STORED = { id: 'p1', name: 'Cat trailer', doc: { clips: [] }, schemaVersion: 1, version: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  listProjects.mockResolvedValue([SUMMARY])
  getProject.mockResolvedValue(STORED)
  useProjectsStore.setState({
    projects: [],
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
})
