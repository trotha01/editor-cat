import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMessage = vi.fn()
const isMockEnabled = vi.fn(() => false)
const mockImprovedPrompt = vi.fn()

vi.mock('./claudeClient', () => ({
  createMessage: (opts: unknown) => createMessage(opts) as unknown,
}))
vi.mock('./mock', () => ({
  isMockEnabled: () => isMockEnabled() as unknown,
  mockImprovedPrompt: (prompt: string) => mockImprovedPrompt(prompt) as unknown,
}))

const { PROMPT_MODEL, enhancePrompt, stripWrapping } = await import('./promptEnhancer')

/** The options `createMessage` was called with on the nth call. */
const sentOn = (call = 0) =>
  createMessage.mock.calls[call]?.[0] as { model: string; system: string; prompt: string }

beforeEach(() => {
  vi.clearAllMocks()
  isMockEnabled.mockReturnValue(false)
})

describe('enhancePrompt', () => {
  it('sends an image prompt to Claude with the image instructions', async () => {
    createMessage.mockResolvedValue('A lighthouse at dusk, storm light raking across wet rock.')

    const improved = await enhancePrompt({ kind: 'image', prompt: 'a lighthouse' })

    expect(improved).toBe('A lighthouse at dusk, storm light raking across wet rock.')
    expect(sentOn().model).toBe(PROMPT_MODEL)
    // The image instructions, not the video ones — the split is the point.
    expect(sentOn().system).toContain('text-to-image')
  })

  it('sends a video prompt to the same Claude, with the video instructions', async () => {
    createMessage.mockResolvedValue('The camera pushes slowly in as rain sheets past the lamp.')

    const improved = await enhancePrompt({ kind: 'video', prompt: 'push in' })

    expect(improved).toBe('The camera pushes slowly in as rain sheets past the lamp.')
    expect(sentOn().model).toBe(PROMPT_MODEL)
    expect(sentOn().system).toContain('image-to-video')
  })

  it('unwraps a conversational answer from Claude', async () => {
    createMessage.mockResolvedValue("Here's an improved prompt: A lighthouse at dusk")

    await expect(enhancePrompt({ kind: 'image', prompt: 'a lighthouse' })).resolves.toBe(
      'A lighthouse at dusk',
    )
  })

  it('reports an empty answer from Claude rather than accepting it', async () => {
    createMessage.mockResolvedValue('   ')

    await expect(enhancePrompt({ kind: 'video', prompt: 'push in' })).rejects.toThrow(
      /empty prompt/,
    )
  })

  it('improves both kinds of prompt offline in mock mode', async () => {
    isMockEnabled.mockReturnValue(true)
    mockImprovedPrompt.mockResolvedValue('a lighthouse [mock enhancement — no LLM was called]')

    for (const kind of ['image', 'video'] as const) {
      const improved = await enhancePrompt({ kind, prompt: 'a lighthouse' })
      expect(improved).toBe('a lighthouse [mock enhancement — no LLM was called]')
    }
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('refuses a blank prompt before calling any provider', async () => {
    await expect(enhancePrompt({ kind: 'image', prompt: '  ' })).rejects.toThrow(
      /Write a prompt first/,
    )
    expect(createMessage).not.toHaveBeenCalled()
  })
})

describe('stripWrapping', () => {
  it('leaves a clean prompt untouched', () => {
    const prompt = 'A lighthouse at dusk, storm light raking across wet rock.'
    expect(stripWrapping(prompt)).toBe(prompt)
  })

  it('removes conversational preambles models add despite being told not to', () => {
    expect(stripWrapping("Here's an improved prompt: A lighthouse at dusk")).toBe(
      'A lighthouse at dusk',
    )
    expect(stripWrapping('Here is the rewritten prompt: A lighthouse')).toBe('A lighthouse')
    expect(stripWrapping('Improved prompt: A lighthouse')).toBe('A lighthouse')
  })

  it('unwraps a fully quoted prompt', () => {
    expect(stripWrapping('"A lighthouse at dusk"')).toBe('A lighthouse at dusk')
  })

  it('keeps quotes that are part of the prompt itself', () => {
    // A sign reading "OPEN" must survive — unwrapping here would corrupt it.
    const prompt = 'A neon sign reading "OPEN" above a diner door'
    expect(stripWrapping(prompt)).toBe(prompt)
  })

  it('strips code fences', () => {
    expect(stripWrapping('```\nA lighthouse at dusk\n```')).toBe('A lighthouse at dusk')
    expect(stripWrapping('```text\nA lighthouse\n```')).toBe('A lighthouse')
  })

  it('trims surrounding whitespace', () => {
    expect(stripWrapping('  \n A lighthouse \n ')).toBe('A lighthouse')
  })
})
