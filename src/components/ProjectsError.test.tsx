import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

/**
 * The notice that has to find someone who was not looking for it.
 *
 * The same failure is repeated in the project menu, which is where anybody
 * reaching for their projects would see it. This one is for everybody else:
 * when the list fails at startup nothing gets opened, so the editor comes up on
 * a blank document that looks exactly like a new project, and every edit made
 * in it goes nowhere. Nobody discovers that by opening a menu they have no
 * reason to open.
 */
const state = {
  listError: null as string | null,
  activeId: null as string | null,
  busy: false,
  reloadProjects: vi.fn(async () => {}),
}

vi.mock('../state/useProjectsStore', () => ({
  useProjectsStore: (selector: (value: typeof state) => unknown) => selector(state),
}))

const { ProjectsError } = await import('./ProjectsError')

beforeEach(() => {
  vi.clearAllMocks()
  state.listError = 'JWT expired'
  state.activeId = null
  state.busy = false
})

describe('the project list notice', () => {
  it('stays out of the way while the list is fine', () => {
    state.listError = null

    const { container } = render(<ProjectsError />)

    expect(container).toBeEmptyDOMElement()
  })

  it('names the failure and what it means for the editor behind it', () => {
    render(<ProjectsError />)

    expect(screen.getByText('Could not load your projects')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('JWT expired')
    // The consequence is the part nothing else on screen says: "Not saved" in
    // the header is a sentence about the last edit, not about a blank project
    // that is not connected to the account at all.
    expect(screen.getByRole('alert')).toHaveTextContent(/nothing you change here is being saved/i)
  })

  it('does not claim the open project is at risk when one is open', () => {
    // A refresh that fails with a project already on screen has put nothing in
    // danger — only the list of the others is missing.
    state.activeId = 'p1'

    render(<ProjectsError />)

    expect(screen.getByRole('alert')).toHaveTextContent(/project on screen is unaffected/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/nothing you change here/i)
  })

  it('offers the retry', () => {
    render(<ProjectsError />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(state.reloadProjects).toHaveBeenCalled()
  })

  it('does not stack a second attempt on one already running', () => {
    state.busy = true

    render(<ProjectsError />)

    expect(screen.getByRole('button', { name: /try again/i })).toBeDisabled()
  })
})
