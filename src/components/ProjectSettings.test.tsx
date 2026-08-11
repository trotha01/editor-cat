import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

/**
 * Where a project is renamed, now that the header title opens the project menu.
 *
 * The header lost its field, so this one has to exist and has to be findable by
 * its label — it is the only way left to change a name.
 */

const projectState = {
  project: { id: 'p1', name: 'Cat trailer' },
  rename: vi.fn(),
}

vi.mock('../state/useProjectStore', () => ({
  useProjectStore: Object.assign(
    (selector: (state: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState },
  ),
}))

const { ProjectSettings } = await import('./ProjectSettings')

beforeEach(() => {
  vi.clearAllMocks()
  projectState.project = { id: 'p1', name: 'Cat trailer' }
})

describe('the project name field', () => {
  it('shows the name of the open project', () => {
    render(<ProjectSettings />)

    expect(screen.getByLabelText(/project name/i)).toHaveValue('Cat trailer')
  })

  it('renames as it is typed, there being nothing here to submit', () => {
    // The name is part of the project document: every keystroke persists
    // locally and rides the ordinary debounce up to the server.
    render(<ProjectSettings />)

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: 'Cat trailer v2' },
    })

    expect(projectState.rename).toHaveBeenCalledWith('Cat trailer v2')
  })
})
