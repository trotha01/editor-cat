import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * What the title in the header is for.
 *
 * It reads as a title and it is the only project control on screen, so a click
 * on it has to do the thing people click a title in a header to do: show what
 * else there is. It was a text field before, which meant the common gesture
 * landed a caret and switching needed a separate arrow. The rules worth holding
 * down are that no click on the name puts it into an editable state, and that
 * the menu it opens still says where renaming went.
 *
 * The menu is also where projects are deleted, from a trash icon a few pixels
 * from the row that switches to one — and what that destroys is hours of work
 * this app cannot reconstruct: the media is recoverable from storage, the
 * arrangement of it is not. So the rule those tests hold is narrow and worth
 * stating plainly: clicking the button must not delete anything. Only answering
 * the question does.
 */

const projectState = {
  project: { id: 'p1', name: 'Cat trailer' },
  rename: vi.fn(),
}

const PROJECTS = [
  { id: 'p1', name: 'Cat trailer', updatedAt: '2026-08-09T12:00:00.000Z', version: 3 },
  { id: 'p2', name: 'Beach reel', updatedAt: '2026-08-01T12:00:00.000Z', version: 1 },
]

const projectsState = {
  status: 'saved' as string,
  projects: PROJECTS,
  archived: [] as { id: string; name: string; deletedAt: string }[],
  activeId: 'p1' as string | null,
  busy: false,
  listError: null as string | null,
  openProject: vi.fn(async () => {}),
  newProject: vi.fn(async () => {}),
  archiveProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  loadArchived: vi.fn(async () => {}),
  reloadProjects: vi.fn(async () => {}),
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

const openSettings = vi.fn()

function mount() {
  return render(<ProjectPicker onOpenSettings={openSettings} />)
}

function title() {
  return screen.getByRole('button', { name: 'Cat trailer' })
}

beforeEach(() => {
  vi.clearAllMocks()
  projectState.project = { id: 'p1', name: 'Cat trailer' }
  projectsState.status = 'saved'
  projectsState.projects = PROJECTS
  projectsState.archived = []
  projectsState.activeId = 'p1'
  projectsState.busy = false
  projectsState.listError = null
})

describe('the project title', () => {
  it('opens the list of projects when it is clicked', () => {
    mount()

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(title())

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Beach reel/ })).toBeInTheDocument()
  })

  it('never turns into a field to type a new name into', () => {
    // The whole point of the change: a click on the title is a request to see
    // the other projects, not to start editing this one's name.
    mount()
    fireEvent.click(title())

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(projectState.rename).not.toHaveBeenCalled()
  })

  it('switches to another project', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('menuitem', { name: /Beach reel/ }))

    expect(projectsState.openProject).toHaveBeenCalledWith('p2')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not reopen the project that is already open', () => {
    // Reopening would flush, refetch and re-adopt the document that is already
    // on screen — a slow no-op that can only lose the current selection.
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('menuitem', { name: /Cat trailer/ }))

    expect(projectsState.openProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('sends anyone looking for the old rename to Settings', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))

    expect(openSettings).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape', () => {
    mount()
    fireEvent.click(title())
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('falls back to a placeholder rather than an empty header', () => {
    projectState.project = { id: 'p1', name: '' }

    mount()

    expect(screen.getByRole('button', { name: 'Untitled project' })).toBeInTheDocument()
  })
})

describe('when the list of projects could not be fetched', () => {
  beforeEach(() => {
    projectsState.listError = 'JWT expired'
    projectsState.projects = []
  })

  it('says so, instead of opening onto what looks like an empty account', () => {
    // A failed fetch and a brand new account produce the same empty menu, and
    // they could not be further apart: one of them means every project the user
    // has is still there and simply was not asked for successfully.
    mount()
    fireEvent.click(title())

    expect(screen.getByText('There was an error getting the projects.')).toBeInTheDocument()
  })

  it('passes on what actually failed, rather than only that something did', () => {
    mount()
    fireEvent.click(title())

    expect(screen.getByText(/JWT expired/)).toBeInTheDocument()
  })

  it('offers the retry from where the failure is read', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(projectsState.reloadProjects).toHaveBeenCalled()
  })

  it('keeps the menu open across the retry, so the result lands in view', () => {
    // The retry is inside the menu, so the dismiss-on-click-away handler leaves
    // it alone — closing here would hide both the spinner and whatever the
    // second attempt has to say.
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('announces itself, having appeared after the screen settled', () => {
    mount()
    fireEvent.click(title())

    expect(screen.getByRole('alert')).toHaveTextContent('There was an error getting the projects.')
  })

  it('says nothing when the list arrived', () => {
    projectsState.listError = null

    mount()
    fireEvent.click(title())

    expect(screen.queryByText(/error getting the projects/i)).not.toBeInTheDocument()
  })
})

describe('deleting a project', () => {
  it('asks before doing anything', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Cat trailer' }))

    // The click that matters is the second one. This one only raises a question.
    expect(projectsState.archiveProject).not.toHaveBeenCalled()
    expect(screen.getByText(/delete this project\?/i)).toBeInTheDocument()
  })

  it('names the project, since the button that opened this is an icon in a list', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Beach reel' }))

    expect(screen.getByText('Beach reel')).toBeInTheDocument()
  })

  it('says the project can be brought back, and for how long', () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Cat trailer' }))

    // The old wording was "this cannot be undone", which was true of a delete
    // and would be a lie about ninety days of grace.
    expect(screen.getByText(/restore it/i)).toHaveTextContent('90 days')
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument()
  })

  it('deletes it when the question is answered', async () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Cat trailer' }))
    fireEvent.click(screen.getByRole('button', { name: /delete project/i }))

    await waitFor(() => expect(projectsState.archiveProject).toHaveBeenCalledWith('p1'))
  })

  it('does nothing at all when it is declined', async () => {
    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: 'Delete Cat trailer' }))
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }))

    await waitFor(() =>
      expect(screen.queryByText(/delete this project\?/i)).not.toBeInTheDocument(),
    )
    expect(projectsState.archiveProject).not.toHaveBeenCalled()
  })
})

describe('the deleted ones', () => {
  it('offers nothing to restore when nothing has been deleted', () => {
    mount()
    fireEvent.click(title())

    // A permanent empty section about something most people never do.
    expect(screen.queryByText('Recently deleted')).not.toBeInTheDocument()
  })

  it('offers a deleted project back, with the time it has left', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    projectsState.archived = [{ id: 'p9', name: 'Otter b-roll', deletedAt: twoDaysAgo }]

    mount()
    fireEvent.click(title())

    expect(screen.getByText('Otter b-roll')).toBeInTheDocument()
    expect(screen.getByText(/88 days left to restore/i)).toBeInTheDocument()
  })

  it('puts one back when asked, without a second question', async () => {
    projectsState.archived = [
      { id: 'p9', name: 'Otter b-roll', deletedAt: new Date().toISOString() },
    ]

    mount()
    fireEvent.click(title())
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))

    // Nothing is lost by restoring, so nothing needs confirming.
    await waitFor(() => expect(projectsState.restoreProject).toHaveBeenCalledWith('p9'))
  })
})
