import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedProject, ProjectSummary } from '../lib/supabase/projects'

/**
 * Deleting a project, and taking it back.
 *
 * A timeline is the one thing here that cannot be reconstructed from anywhere
 * else — the media is in Drive and the metadata is on the server, but the
 * arrangement is hours of somebody's decisions. So the delete is a stamp rather
 * than a delete, and these hold the two halves of that: the project leaves the
 * list without leaving the account, and comes back where it belongs.
 */
const archiveProject = vi.fn<(id: string) => Promise<string>>()
const restoreProject = vi.fn<(id: string) => Promise<ProjectSummary>>()
const listArchivedProjects = vi.fn<() => Promise<ArchivedProject[]>>()
const listProjects = vi.fn<() => Promise<ProjectSummary[]>>()
const purgeExpiredProjects = vi.fn(async () => {})
const getProject = vi.fn()
const createProject = vi.fn()
const updateProject = vi.fn()

class FakeConflictError extends Error {}

vi.mock('../lib/supabase/projects', () => ({
  archiveProject: (id: string) => archiveProject(id),
  restoreProject: (id: string) => restoreProject(id),
  listArchivedProjects: () => listArchivedProjects(),
  listProjects: () => listProjects(),
  purgeExpiredProjects: () => purgeExpiredProjects(),
  getProject: (id: string) => getProject(id) as unknown,
  createProject: (...args: unknown[]) => createProject(...args) as unknown,
  updateProject: (...args: unknown[]) => updateProject(...args) as unknown,
  ProjectConflictError: FakeConflictError,
  fromStored: (stored: { id: string; name: string; doc: unknown }) => ({
    id: stored.id,
    name: stored.name,
    ...(stored.doc as object),
  }),
  toDoc: (project: unknown) => project,
}))

const deleteLocal = vi.fn<(id: string) => Promise<void>>(async () => {})

vi.mock('../lib/db', () => ({
  deleteProject: (id: string) => deleteLocal(id),
  saveProject: vi.fn(async () => {}),
  loadProject: vi.fn(async () => undefined),
  listAssets: vi.fn(async () => []),
  putAsset: vi.fn(async () => {}),
  deleteAsset: vi.fn(async () => {}),
  getBlob: vi.fn(async () => undefined),
}))

vi.mock('../lib/sync/hydrate', () => ({ hydrateProject: vi.fn(async () => []) }))

vi.mock('./useAuthStore', () => ({ requiresSignIn: () => true }))

const { useProjectsStore } = await import('./useProjectsStore')

const summary = (id: string, name: string, updatedAt: string): ProjectSummary => ({
  id,
  name,
  updatedAt,
  version: 1,
})

const OTTERS = summary('p1', 'Sea otters', '2026-08-01T00:00:00Z')
const LIONS = summary('p2', 'Lion cut', '2026-07-01T00:00:00Z')

const DELETED_AT = '2026-08-11T09:00:00Z'

/** A stored project, as the server hands one back. */
const doc = { clips: [], audioTracks: [], audioClips: [], width: 720, height: 1280, fps: 30 }

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  archiveProject.mockResolvedValue(DELETED_AT)
  listArchivedProjects.mockResolvedValue([])
  listProjects.mockResolvedValue([OTTERS, LIONS])
  getProject.mockImplementation(async (id: string) => ({
    id,
    name: id === 'p1' ? 'Sea otters' : 'Lion cut',
    doc,
    schemaVersion: 3,
    version: 1,
    updatedAt: '2026-08-01T00:00:00Z',
  }))
  useProjectsStore.setState({
    projects: [OTTERS, LIONS],
    archived: [],
    // Neither of them open, so archiving does not go on to swap the editor's
    // contents — that path has its own test below.
    activeId: null,
    status: 'saved',
    error: null,
    busy: false,
  })
})

describe('archiveProject', () => {
  it('takes the project out of the list', async () => {
    await useProjectsStore.getState().archiveProject('p1')

    expect(useProjectsStore.getState().projects).toEqual([LIONS])
  })

  it('keeps it, so there is something to restore', async () => {
    await useProjectsStore.getState().archiveProject('p1')

    // Put there without refetching: the way back should be on screen the moment
    // it leaves the list above it.
    expect(useProjectsStore.getState().archived).toEqual([{ ...OTTERS, deletedAt: DELETED_AT }])
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
    //
    // Started properly rather than with `setState`, because the flush is the
    // whole point and there is no scheduler to flush until a project has been
    // opened the long way round.
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
    expect(useProjectsStore.getState().projects).toEqual([OTTERS, LIONS])
    expect(useProjectsStore.getState().archived).toEqual([])
    expect(useProjectsStore.getState().error).toBe('That project no longer exists.')
  })
})

describe('restoreProject', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      projects: [OTTERS],
      archived: [{ ...LIONS, deletedAt: DELETED_AT }],
    })
  })

  it('puts it back in the list, in the order the list is kept in', async () => {
    restoreProject.mockResolvedValue(LIONS)

    await useProjectsStore.getState().restoreProject('p2')

    // By last edit, not appended: a project last touched in July belongs under
    // one touched in August, wherever it has just come from.
    expect(useProjectsStore.getState().projects).toEqual([OTTERS, LIONS])
    expect(useProjectsStore.getState().archived).toEqual([])
  })

  it('sorts a recently edited one back to the top', async () => {
    const fresh = { ...LIONS, updatedAt: '2026-08-09T00:00:00Z' }
    restoreProject.mockResolvedValue(fresh)

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
    listArchivedProjects.mockResolvedValue([{ ...LIONS, deletedAt: DELETED_AT }])

    await useProjectsStore.getState().loadArchived()

    expect(useProjectsStore.getState().archived).toEqual([{ ...LIONS, deletedAt: DELETED_AT }])
  })

  it('says nothing when it cannot be fetched', async () => {
    useProjectsStore.setState({ archived: [{ ...LIONS, deletedAt: DELETED_AT }] })
    listArchivedProjects.mockRejectedValue(new Error('offline'))

    await useProjectsStore.getState().loadArchived()

    // Opening a menu is not asking for this, and an error banner over it would
    // be about something the user did not do.
    expect(useProjectsStore.getState().error).toBeNull()
    expect(useProjectsStore.getState().archived).toHaveLength(1)
  })
})

describe('start', () => {
  it('clears out projects whose ninety days have run out', async () => {
    await useProjectsStore.getState().start()

    // The only clock this app has: nothing runs when nobody is signed in, so
    // the sweep happens on the way in.
    expect(purgeExpiredProjects).toHaveBeenCalled()
  })
})
