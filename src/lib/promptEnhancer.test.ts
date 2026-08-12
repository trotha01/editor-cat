import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMessage = vi.fn()
const run = vi.fn()
const isMockEnabled = vi.fn(() => false)
const mockImprovedPrompt = vi.fn()

vi.mock('./claudeClient', () => ({
  createMessage: (opts: unknown) => createMessage(opts) as unknown,
}))
vi.mock('./falClient', () => ({
  run: (endpoint: string, input: unknown, options?: unknown) =>
    run(endpoint, input, options) as unknown,
}))
vi.mock('./mock', () => ({
  isMockEnabled: () => isMockEnabled() as unknown,
  mockImprovedPrompt: (prompt: string) => mockImprovedPrompt(prompt) as unknown,
}))

const { IMAGE_MODEL, enhancePrompt, stripWrapping } = await import('./promptEnhancer')

beforeEach(() => {
  vi.clearAllMocks()
  isMockEnabled.mockReturnValue(false)
})

describe('enhancePrompt', () => {
  it('sends an image prompt to Claude rather than to fal', async () => {
    createMessage.mockResolvedValue('A lighthouse at dusk, storm light raking across wet rock.')

    const improved = await enhancePrompt({
      kind: 'image',
      prompt: 'a lighthouse',
      model: 'google/gemini-flash-1.5',
    })

    expect(improved).toBe('A lighthouse at dusk, storm light raking across wet rock.')
    expect(run).not.toHaveBeenCalled()
    const sent = createMessage.mock.calls[0]?.[0] as { model: string; system: string }
    expect(sent.model).toBe(IMAGE_MODEL)
    // The image instructions, not the video ones — the split is the point.
    expect(sent.system).toContain('text-to-image')
  })

  it('unwraps a conversational answer from Claude', async () => {
    createMessage.mockResolvedValue("Here's an improved prompt: A lighthouse at dusk")

    await expect(
      enhancePrompt({ kind: 'image', prompt: 'a lighthouse', model: 'x' }),
    ).resolves.toBe('A lighthouse at dusk')
  })

  it('reports an empty answer from Claude rather than accepting it', async () => {
    createMessage.mockResolvedValue('   ')

    await expect(
      enhancePrompt({ kind: 'image', prompt: 'a lighthouse', model: 'x' }),
    ).rejects.toThrow(/empty prompt/)
  })

  it('keeps the video prompt on the picked fal model', async () => {
    run.mockResolvedValue({ output: 'The camera pushes slowly in as rain sheets past the lamp.' })

    const improved = await enhancePrompt({
      kind: 'video',
      prompt: 'push in',
      model: 'google/gemini-flash-1.5',
    })

    expect(improved).toBe('The camera pushes slowly in as rain sheets past the lamp.')
    expect(createMessage).not.toHaveBeenCalled()
    const [endpoint, input] = run.mock.calls[0] as [
      string,
      { model: string; system_prompt: string },
    ]
    expect(endpoint).toBe('fal-ai/any-llm')
    expect(input.model).toBe('google/gemini-flash-1.5')
    expect(input.system_prompt).toContain('image-to-video')
  })

  it('improves image prompts offline in mock mode', async () => {
    isMockEnabled.mockReturnValue(true)
    mockImprovedPrompt.mockResolvedValue('a lighthouse [mock enhancement — no LLM was called]')

    const improved = await enhancePrompt({ kind: 'image', prompt: 'a lighthouse', model: 'x' })

    expect(improved).toBe('a lighthouse [mock enhancement — no LLM was called]')
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('refuses a blank prompt before calling any provider', async () => {
    await expect(enhancePrompt({ kind: 'image', prompt: '  ', model: 'x' })).rejects.toThrow(
      /Write a prompt first/,
    )
    expect(createMessage).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
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
