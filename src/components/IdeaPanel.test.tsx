import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const generateIdeas = vi.fn()

vi.mock('../lib/ideaGenerator', () => ({
  generateIdeas: (input: unknown) => generateIdeas(input) as unknown,
}))

const { IdeaPanel } = await import('./IdeaPanel')

const IDEAS = Array.from({ length: 20 }, (_, i) => `Idea number ${i + 1}.`)

beforeEach(() => {
  vi.clearAllMocks()
  generateIdeas.mockResolvedValue(IDEAS)
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

describe('the Idea tab', () => {
  it('does nothing until a word is generated from', () => {
    render(<IdeaPanel />)
    expect(screen.getByRole('button', { name: /Generate 20 ideas/ })).toBeDisabled()
    expect(generateIdeas).not.toHaveBeenCalled()
  })

  it('generates ideas for the typed word and lists all of them', async () => {
    render(<IdeaPanel />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))

    await waitFor(() => expect(generateIdeas).toHaveBeenCalledWith({ word: 'umbrella' }))
    expect(await screen.findByText('Idea number 1.')).toBeInTheDocument()
    expect(screen.getByText('Idea number 20.')).toBeInTheDocument()
  })

  it('shows a failure and leaves the word in place so it can be retried', async () => {
    generateIdeas.mockRejectedValue(new Error('Claude returned no ideas. Try a different word.'))

    render(<IdeaPanel />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Claude returned no ideas')
    expect(screen.getByRole('textbox')).toHaveValue('umbrella')
  })

  it('copies an idea to the clipboard', async () => {
    render(<IdeaPanel />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))
    await screen.findByText('Idea number 1.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]!)

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Idea number 1.'),
    )
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
