import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * What stands between a click and a lost timeline.
 *
 * The delete button is an icon a few pixels from the row that switches
 * projects, inside a menu that scrolls, and what it destroys is hours of work
 * this app cannot reconstruct — the media is recoverable from Drive, the
 * arrangement of it is not. So the rule these tests hold is narrow and worth
 * stating plainly: clicking the button must not delete anything. Only answering
 * the question does.
 */
const projectState = {
  project: { name: 'A project' },
  rename: vi.fn(),
}

const projectsState = {
  status: 'saved' as string,
  projects: [
    { id: 'p1', name: 'Sea otters', updatedAt: '2026-08-01T00:00:00Z', version: 1 },
    { id: 'p2', name: 'Lion cut', updatedAt: '2026-07-01T00:00:00Z', version: 1 },
  ],
  archived: [] as {
    id: string
    name: string
    deletedAt: string
    updatedAt: string
    version: number
  }[],
  activeId: 'p1',
  busy: false,
  openProject: vi.fn(async () => {}),
  newProject: vi.fn(async () => {}),
  archiveProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  loadArchived: vi.fn(async () => {}),
}

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: Object.assign(
    (selector: (state: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState },
  ),
}))

vi.mock('../state/useProjectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
    { getState: () => projectsState },
  ),
}))

const { ProjectPicker } = await import('./ProjectPicker')

/** Opens the project menu, which is where every one of these starts. */
function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: /switch project/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  projectsState.status = 'saved'
  projectsState.archived = []
  render(<ProjectPicker />)
})

describe('deleting a project', () => {
  it('asks before doing anything', () => {
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sea otters' }))

    // The click that matters is the second one. This one only raises a question.
    expect(projectsState.archiveProject).not.toHaveBeenCalled()
    expect(screen.getByText(/delete this project\?/i)).toBeInTheDocument()
  })

  it('names the project, since the button that opened this is an icon in a list', () => {
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Lion cut' }))

    expect(screen.getByText('Lion cut')).toBeInTheDocument()
  })

  it('says the project can be brought back, and for how long', () => {
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sea otters' }))

    // The old wording was "this cannot be undone", which was true of a delete
    // and would be a lie about ninety days of grace.
    expect(screen.getByText(/restore it/i)).toHaveTextContent('90 days')
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument()
  })

  it('deletes it when the question is answered', async () => {
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sea otters' }))
    fireEvent.click(screen.getByRole('button', { name: /delete project/i }))

    await waitFor(() => expect(projectsState.archiveProject).toHaveBeenCalledWith('p1'))
  })

  it('does nothing at all when it is declined', async () => {
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sea otters' }))
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }))

    await waitFor(() =>
      expect(screen.queryByText(/delete this project\?/i)).not.toBeInTheDocument(),
    )
    expect(projectsState.archiveProject).not.toHaveBeenCalled()
  })
})

describe('the deleted ones', () => {
  it('offers nothing to restore when nothing has been deleted', () => {
    openMenu()

    // A permanent empty section about something most people never do.
    expect(screen.queryByText('Recently deleted')).not.toBeInTheDocument()
  })

  it('offers a deleted project back, with the time it has left', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    projectsState.archived = [
      { id: 'p9', name: 'Otter b-roll', deletedAt: twoDaysAgo, updatedAt: twoDaysAgo, version: 1 },
    ]

    openMenu()

    expect(screen.getByText('Otter b-roll')).toBeInTheDocument()
    expect(screen.getByText(/88 days left to restore/i)).toBeInTheDocument()
  })

  it('puts one back when asked, without a second question', async () => {
    projectsState.archived = [
      {
        id: 'p9',
        name: 'Otter b-roll',
        deletedAt: new Date().toISOString(),
        updatedAt: '2026-07-01T00:00:00Z',
        version: 1,
      },
    ]

    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))

    // Nothing is lost by restoring, so nothing needs confirming.
    await waitFor(() => expect(projectsState.restoreProject).toHaveBeenCalledWith('p9'))
  })
})
