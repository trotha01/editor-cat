import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The Idea tab, with the model faked.
 *
 * What is worth testing here is not that the AI answers — that is
 * `parseSuggestions` — but the two rules the step exists to enforce. A
 * suggested verb is *added* to your sentence rather than replacing it, and a
 * suggested idea replaces it only once you say so, with the old one still
 * recoverable. Both are the kind of thing that quietly regresses into "the app
 * ate what I wrote".
 */
const suggestParts = vi.fn()
const suggestIdeas = vi.fn()

vi.mock('../lib/idea', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idea')>()),
  suggestParts: (options: unknown) => suggestParts(options),
  suggestIdeas: (options: unknown) => suggestIdeas(options),
}))

const { IdeaPanel } = await import('./IdeaPanel')
const { useIdeaStore } = await import('../state/useIdeaStore')

const click = (element: HTMLElement) => fireEvent.click(element)
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })

const ideaBox = () => screen.getByLabelText('Idea')

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  useIdeaStore.setState({ word: '', language: 'latin', sentence: '', focus: null })
  suggestParts.mockResolvedValue([{ text: 'currit', gloss: 'runs' }, { text: 'dormit' }])
  suggestIdeas.mockResolvedValue([
    { text: 'Canis in horto currit.', gloss: 'The dog runs in the garden.' },
    { text: 'Canis per nivem currit.' },
  ])
})

describe('starting from a word', () => {
  it('defaults to Latin, and asks the model in whatever language is chosen', async () => {
    render(<IdeaPanel />)

    expect(screen.getByLabelText('Language')).toHaveValue('latin')

    type(screen.getByLabelText('Word'), 'canis')
    click(screen.getByRole('button', { name: /suggest verbs/i }))

    await waitFor(() =>
      expect(suggestParts).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'verb', word: 'canis', language: 'latin' }),
      ),
    )
  })

  it('will not ask for suggestions before there is a word to build on', () => {
    render(<IdeaPanel />)

    expect(screen.getByRole('button', { name: /suggest verbs/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /suggest objects/i })).toBeDisabled()
  })

  it('adds a suggestion to the sentence instead of overwriting it', async () => {
    useIdeaStore.setState({ word: 'canis', sentence: 'canis' })
    render(<IdeaPanel />)

    click(screen.getByRole('button', { name: /suggest verbs/i }))
    click(await screen.findByRole('button', { name: /currit/ }))

    expect(ideaBox()).toHaveValue('canis currit')
  })

  it('says what went wrong rather than showing an empty list', async () => {
    suggestParts.mockRejectedValue(new Error('The model returned nothing usable.'))
    useIdeaStore.setState({ word: 'canis' })
    render(<IdeaPanel />)

    click(screen.getByRole('button', { name: /suggest verbs/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('nothing usable')
  })
})

describe('exploring a word in the idea', () => {
  it('has nothing to explore until a sentence exists', () => {
    render(<IdeaPanel />)

    expect(screen.queryByRole('group', { name: /word by word/i })).not.toBeInTheDocument()
  })

  it('builds new ideas from the word that was picked, not the whole sentence', async () => {
    useIdeaStore.setState({ word: 'canis', sentence: 'canis in horto dormit' })
    render(<IdeaPanel />)

    click(screen.getByRole('button', { name: 'horto' }))
    click(screen.getByRole('button', { name: /new ideas for/i }))

    await waitFor(() =>
      expect(suggestIdeas).toHaveBeenCalledWith(
        expect.objectContaining({ focus: 'horto', sentence: 'canis in horto dormit' }),
      ),
    )
  })

  it('keeps the sentence until an idea is chosen, and can put it back after', async () => {
    useIdeaStore.setState({ word: 'canis', sentence: 'canis in horto dormit' })
    render(<IdeaPanel />)

    click(screen.getByRole('button', { name: 'canis' }))
    click(screen.getByRole('button', { name: /new ideas for/i }))
    await screen.findByText('Canis in horto currit.')

    // Shown alongside; nothing has changed yet.
    expect(ideaBox()).toHaveValue('canis in horto dormit')

    click(screen.getAllByRole('button', { name: 'Use this' })[0]!)
    expect(ideaBox()).toHaveValue('Canis in horto currit.')

    click(screen.getByRole('button', { name: 'Undo' }))
    expect(ideaBox()).toHaveValue('canis in horto dormit')
  })

  it('drops the picked word when the sentence is edited under it', () => {
    useIdeaStore.setState({ word: 'canis', sentence: 'canis dormit' })
    render(<IdeaPanel />)

    click(screen.getByRole('button', { name: 'dormit' }))
    expect(screen.getByRole('button', { name: /new ideas for/i })).toBeEnabled()

    // The word at that position is no longer the one that was picked, so asking
    // for ideas about it would be asking about something else.
    type(ideaBox(), 'canis in horto dormit')
    expect(screen.getByRole('button', { name: /new ideas for a word/i })).toBeDisabled()
  })
})
