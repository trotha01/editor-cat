import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const generateIdeas = vi.fn()

vi.mock('../lib/ideaGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ideaGenerator')>()),
  generateIdeas: (input: unknown) => generateIdeas(input) as unknown,
}))

const { IdeaPanel } = await import('./IdeaPanel')
const { useIdeaStore } = await import('../state/useIdeaStore')
const { buildIdeaSystemPrompt, DEFAULT_IDEA_COUNT } = await import('../lib/ideaGenerator')

const IDEAS = Array.from({ length: 20 }, (_, i) => `Idea number ${i + 1}.`)
const DEFAULT_PROMPT = buildIdeaSystemPrompt(DEFAULT_IDEA_COUNT)

const wordBox = () => screen.getByLabelText('A word to build scenes around')
const countBox = () => screen.getByLabelText('How many')
const promptBox = () => screen.getByLabelText('Prompt sent to Claude')

beforeEach(() => {
  vi.clearAllMocks()
  generateIdeas.mockResolvedValue(IDEAS)
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  useIdeaStore.setState({
    word: '',
    count: DEFAULT_IDEA_COUNT,
    prompt: DEFAULT_PROMPT,
    ideas: null,
    busy: false,
    error: null,
  })
})

describe('the Idea tab', () => {
  it('does nothing until a word is generated from', () => {
    render(<IdeaPanel />)
    expect(screen.getByRole('button', { name: /Generate 20 ideas/ })).toBeDisabled()
    expect(generateIdeas).not.toHaveBeenCalled()
  })

  it('generates ideas for the typed word and lists all of them', async () => {
    render(<IdeaPanel />)

    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))

    await waitFor(() =>
      expect(generateIdeas).toHaveBeenCalledWith({
        word: 'umbrella',
        count: DEFAULT_IDEA_COUNT,
        systemPrompt: DEFAULT_PROMPT,
      }),
    )
    expect(await screen.findByText('Idea number 1.')).toBeInTheDocument()
    expect(screen.getByText('Idea number 20.')).toBeInTheDocument()
  })

  it('shows a failure and leaves the word in place so it can be retried', async () => {
    generateIdeas.mockRejectedValue(new Error('Claude returned no ideas. Try a different word.'))

    render(<IdeaPanel />)
    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Claude returned no ideas')
    expect(wordBox()).toHaveValue('umbrella')
  })

  it('copies an idea to the clipboard', async () => {
    render(<IdeaPanel />)
    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))
    await screen.findByText('Idea number 1.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]!)

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Idea number 1.'),
    )
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('keeps the word and generated ideas after switching away and back to the tab', async () => {
    // The panel unmounts when another tab is picked (see App.tsx), and remounts
    // when this one is picked again — so the state behind it has to live
    // somewhere that switching tabs does not tear down.
    const { unmount } = render(<IdeaPanel />)
    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))
    await screen.findByText('Idea number 1.')

    unmount()
    render(<IdeaPanel />)

    expect(wordBox()).toHaveValue('umbrella')
    expect(screen.getByText('Idea number 1.')).toBeInTheDocument()
    expect(screen.getByText('Idea number 20.')).toBeInTheDocument()
    expect(generateIdeas).toHaveBeenCalledTimes(1)
  })

  it('pre-fills the prompt box with the prompt that is actually sent', () => {
    render(<IdeaPanel />)
    expect(promptBox()).toHaveValue(DEFAULT_PROMPT)
  })

  it('sends an edited prompt instead of the default one', async () => {
    render(<IdeaPanel />)
    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.change(promptBox(), { target: { value: 'Write scenes set in 1890.' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate 20 ideas/ }))

    await waitFor(() =>
      expect(generateIdeas).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'Write scenes set in 1890.' }),
      ),
    )
  })

  it('asks for the chosen number of ideas, and says so on the button', async () => {
    render(<IdeaPanel />)
    fireEvent.change(wordBox(), { target: { value: 'umbrella' } })
    fireEvent.change(countBox(), { target: { value: '5' } })

    const button = screen.getByRole('button', { name: /Generate 5 ideas/ })
    fireEvent.click(button)

    await waitFor(() =>
      expect(generateIdeas).toHaveBeenCalledWith(expect.objectContaining({ count: 5 })),
    )
  })

  it('rewrites the untouched prompt when the count changes', () => {
    render(<IdeaPanel />)
    fireEvent.change(countBox(), { target: { value: '5' } })

    expect(promptBox()).toHaveValue(buildIdeaSystemPrompt(5))
    expect(screen.queryByRole('button', { name: 'Reset prompt' })).not.toBeInTheDocument()
  })

  it('leaves an edited prompt alone when the count changes, and can restore it', () => {
    render(<IdeaPanel />)
    fireEvent.change(promptBox(), { target: { value: 'Write scenes set in 1890.' } })
    fireEvent.change(countBox(), { target: { value: '5' } })

    expect(promptBox()).toHaveValue('Write scenes set in 1890.')

    fireEvent.click(screen.getByRole('button', { name: 'Reset prompt' }))
    expect(promptBox()).toHaveValue(buildIdeaSystemPrompt(5))
  })

  it('ignores a count outside the allowed range while it is being typed', () => {
    render(<IdeaPanel />)

    // Clearing the box to retype it must not snap a clamped number back under
    // the cursor — the typed text stands until it parses to something usable.
    fireEvent.change(countBox(), { target: { value: '' } })
    expect(countBox()).toHaveValue(null)
    expect(screen.getByRole('button', { name: /Generate 20 ideas/ })).toBeInTheDocument()

    fireEvent.change(countBox(), { target: { value: '500' } })
    expect(screen.getByRole('button', { name: /Generate 20 ideas/ })).toBeInTheDocument()

    // Blur puts the box back in step with the count that was actually kept.
    fireEvent.blur(countBox())
    expect(countBox()).toHaveValue(20)
  })
})
