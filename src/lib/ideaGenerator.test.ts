import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMessage = vi.fn()
const isMockEnabled = vi.fn(() => false)
const mockIdeas = vi.fn()

vi.mock('./claudeClient', () => ({
  createMessage: (opts: unknown) => createMessage(opts) as unknown,
}))
vi.mock('./mock', () => ({
  isMockEnabled: () => isMockEnabled() as unknown,
  mockIdeas: (word: string) => mockIdeas(word) as unknown,
}))

const { IDEA_COUNT, IDEA_MODEL, generateIdeas, parseIdeas } = await import('./ideaGenerator')

beforeEach(() => {
  vi.clearAllMocks()
  isMockEnabled.mockReturnValue(false)
})

describe('parseIdeas', () => {
  it('parses a clean JSON array', () => {
    const ideas = JSON.stringify(['A raccoon files a noise complaint.', 'A toaster interviews.'])
    expect(parseIdeas(ideas)).toEqual([
      'A raccoon files a noise complaint.',
      'A toaster interviews.',
    ])
  })

  it('parses a JSON array wrapped in a code fence and preamble', () => {
    const text = 'Here is the list:\n```json\n["One idea.", "Two idea."]\n```'
    expect(parseIdeas(text)).toEqual(['One idea.', 'Two idea.'])
  })

  it('falls back to a numbered list when the model ignores the JSON instruction', () => {
    const text =
      '1. A raccoon files a noise complaint.\n2. A toaster interviews for a job.\n3. Done.'
    expect(parseIdeas(text)).toEqual([
      'A raccoon files a noise complaint.',
      'A toaster interviews for a job.',
      'Done.',
    ])
  })

  it('falls back to a bulleted list', () => {
    const text = '- First idea.\n* Second idea.\n> Third idea.'
    expect(parseIdeas(text)).toEqual(['First idea.', 'Second idea.', 'Third idea.'])
  })

  it('drops blank lines', () => {
    const text = 'First idea.\n\n\nSecond idea.'
    expect(parseIdeas(text)).toEqual(['First idea.', 'Second idea.'])
  })

  it('returns an empty array for empty text', () => {
    expect(parseIdeas('')).toEqual([])
  })

  it('ignores non-string entries in a JSON array', () => {
    const text = JSON.stringify(['A real idea.', null, 42, '  '])
    expect(parseIdeas(text)).toEqual(['A real idea.'])
  })

  it('repairs a JSON array missing the closing quote on its last element', () => {
    // A real response that came back exactly this way: 20 well-formed ideas,
    // but the very last one was missing the quote that closes its string,
    // right before the array's own `]`. Without a fix, that single missing
    // character used to fail the whole parse and dump all 20 ideas into one.
    const ideas = ['First idea.', 'Second idea, with a line of "dialogue" in it.']
    const text = JSON.stringify(ideas)
    expect(text.endsWith('"]')).toBe(true)
    const broken = `${text.slice(0, -2)}]` // drop the closing `"` before `]`

    expect(() => JSON.parse(broken)).toThrow()
    expect(parseIdeas(broken)).toEqual(ideas)
  })

  it('recovers the well-formed ideas from an array missing commas between elements', () => {
    const text = '["First idea." "Second idea." "Third idea."]'
    expect(() => JSON.parse(text)).toThrow()
    expect(parseIdeas(text)).toEqual(['First idea.', 'Second idea.', 'Third idea.'])
  })

  it('still falls back to a numbered list when the lines themselves quote dialogue', () => {
    // Quoted literal recovery is gated on the response actually looking like a
    // JSON array (starting with `[`), so it must not hijack a plain numbered
    // list just because each line happens to contain a quote.
    const text = '1. A raccoon knocks: "Let me in."\n2. A toaster says: "Not today."'
    expect(parseIdeas(text)).toEqual([
      'A raccoon knocks: "Let me in."',
      'A toaster says: "Not today."',
    ])
  })
})

describe('IDEA_COUNT', () => {
  it('is the number of ideas requested from the model', () => {
    expect(IDEA_COUNT).toBe(20)
  })
})

describe('generateIdeas', () => {
  it('asks Claude directly, not through fal', async () => {
    createMessage.mockResolvedValue(JSON.stringify(['Idea one.', 'Idea two.']))

    const ideas = await generateIdeas({ word: 'umbrella' })

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: IDEA_MODEL, prompt: 'umbrella' }),
    )
    expect(ideas).toEqual(['Idea one.', 'Idea two.'])
  })

  it('rejects a blank word without calling Claude', async () => {
    await expect(generateIdeas({ word: '   ' })).rejects.toThrow('Type a word first')
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('throws when Claude returns nothing parseable as ideas', async () => {
    createMessage.mockResolvedValue('')

    await expect(generateIdeas({ word: 'umbrella' })).rejects.toThrow('Claude returned no ideas')
  })

  it('uses the offline mock generator in mock mode, without calling Claude', async () => {
    isMockEnabled.mockReturnValue(true)
    mockIdeas.mockResolvedValue(['Mock idea.'])

    const ideas = await generateIdeas({ word: 'umbrella' })

    expect(mockIdeas).toHaveBeenCalledWith('umbrella')
    expect(createMessage).not.toHaveBeenCalled()
    expect(ideas).toEqual(['Mock idea.'])
  })
})
