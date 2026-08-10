import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Reading a reply out of a model that was asked to follow a format.
 *
 * The models this can run on go from Claude down to a 3B Llama, and the small
 * ones treat "reply with exactly this block" as a suggestion — so the parsing
 * has to cope with a mangled fence, and must never invent a report out of one.
 * A draft that nobody wrote is the failure that matters here: it puts words in
 * someone's mouth on a public tracker, one button press away.
 */
const run = vi.fn()

vi.mock('../falClient', () => ({
  run: (model: string, input: Record<string, unknown>, options?: unknown) =>
    run(model, input, options) as unknown,
}))

const { askAssistant, buildPrompt, parseReply } = await import('./chat')

const FILING = { canFile: true }

function reportBlock(json: string): string {
  return ['Here is a draft you can check.', '', '```report', json, '```'].join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildPrompt', () => {
  it('writes the conversation out as a transcript', () => {
    const prompt = buildPrompt([
      { role: 'user', text: 'How do I trim a clip?' },
      { role: 'assistant', text: 'Drag its edge.' },
      { role: 'user', text: 'And split one?' },
    ])

    expect(prompt).toContain('User: How do I trim a clip?')
    expect(prompt).toContain('Assistant: Drag its edge.')
    // Without the trailing label, smaller models write both sides.
    expect(prompt.endsWith('\n\nAssistant:')).toBe(true)
  })

  it('drops the oldest turns rather than the newest', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      text: `${i === 39 ? 'LATEST' : 'x'.repeat(500)}`,
    }))

    const prompt = buildPrompt(messages)

    expect(prompt).toContain('LATEST')
    expect(prompt.length).toBeLessThan(12_000)
  })

  it('keeps the newest turn even when it is over budget on its own', () => {
    // A budget that can drop the question leaves the model answering nothing.
    const prompt = buildPrompt([{ role: 'user', text: 'y'.repeat(9000) }])
    expect(prompt).toContain('yyy')
  })
})

describe('parseReply', () => {
  it('returns plain prose untouched', () => {
    const reply = parseReply('Press S to split the clip under the playhead.', FILING)

    expect(reply.draft).toBeNull()
    expect(reply.text).toBe('Press S to split the clip under the playhead.')
  })

  it('pulls a drafted report out of the visible text', () => {
    const reply = parseReply(
      reportBlock('{"kind": "bug", "title": "Captions drift", "body": "By a second."}'),
      FILING,
    )

    expect(reply.draft).toEqual({ kind: 'bug', title: 'Captions drift', body: 'By a second.' })
    expect(reply.text).toBe('Here is a draft you can check.')
    expect(reply.text).not.toContain('```')
  })

  it('copes with a fence the model never closed', () => {
    const reply = parseReply(
      '```report\n{"kind": "feature", "title": "Export SRT", "body": "As a sidecar."}',
      FILING,
    )

    expect(reply.draft?.kind).toBe('feature')
  })

  it('copes with a trailing comma', () => {
    const reply = parseReply(
      reportBlock('{"kind": "bug", "title": "Export hangs", "body": "At 40%.",}'),
      FILING,
    )

    expect(reply.draft?.title).toBe('Export hangs')
  })

  it('copes with a model that wrote lines instead of JSON', () => {
    const reply = parseReply(
      reportBlock('kind: feature\ntitle: Undo\nbody: There is no undo.\nIt should be Ctrl+Z.'),
      FILING,
    )

    expect(reply.draft).toEqual({
      kind: 'feature',
      title: 'Undo',
      body: 'There is no undo.\nIt should be Ctrl+Z.',
    })
  })

  it('maps a kind it was not offered onto one the tracker has', () => {
    const reply = parseReply(
      reportBlock('{"kind": "enhancement", "title": "Undo", "body": "There is none."}'),
      FILING,
    )

    expect(reply.draft?.kind).toBe('feature')
  })

  it('says something above a draft that arrived with no prose', () => {
    const reply = parseReply('```report\n{"title": "Undo", "body": "There is none."}\n```', FILING)

    expect(reply.draft).not.toBeNull()
    expect(reply.text).not.toBe('')
  })

  it.each([
    ['a block with no title', '{"kind": "bug", "body": "It broke."}'],
    ['a block with no body', '{"kind": "bug", "title": "It broke"}'],
    ['a block that is not readable at all', 'sorry, I could not fill this in'],
  ])('refuses to invent a report from %s', (_label, inner) => {
    const reply = parseReply(reportBlock(inner), FILING)

    expect(reply.draft).toBeNull()
    // The mess stays visible rather than being hidden: the user can see the
    // model fumbled it, which beats a confident nothing.
    expect(reply.text).toContain('Here is a draft you can check.')
  })

  it('drops a block outright where nothing can be filed', () => {
    const reply = parseReply(
      reportBlock('{"kind": "bug", "title": "Captions drift", "body": "By a second."}'),
      { canFile: false },
    )

    expect(reply.draft).toBeNull()
    expect(reply.text).toBe('Here is a draft you can check.')
  })
})

describe('askAssistant', () => {
  it('runs on the chosen model and returns what it made of the reply', async () => {
    run.mockResolvedValue({ output: 'Press F for fullscreen.' })

    const reply = await askAssistant({
      messages: [{ role: 'user', text: 'How do I go fullscreen?' }],
      model: 'anthropic/claude-3.5-sonnet',
      canFile: true,
      repo: 'owner/repo',
    })

    expect(reply.text).toBe('Press F for fullscreen.')

    const [, input] = run.mock.calls[0] as [string, Record<string, string>]
    expect(input.model).toBe('anthropic/claude-3.5-sonnet')
    expect(input.system_prompt).toContain('owner/repo')
    expect(input.prompt).toContain('How do I go fullscreen?')
  })

  it('tells the model not to offer what this deployment cannot do', async () => {
    run.mockResolvedValue({ output: 'Sorry, no.' })

    await askAssistant({
      messages: [{ role: 'user', text: 'Report a bug' }],
      model: 'anthropic/claude-3.5-sonnet',
      canFile: false,
      repo: null,
    })

    const [, input] = run.mock.calls[0] as [string, Record<string, string>]
    expect(input.system_prompt).toContain('no issue tracker configured')
  })

  it('treats an empty answer as a failure worth showing', async () => {
    run.mockResolvedValue({ output: '   ' })

    await expect(
      askAssistant({
        messages: [{ role: 'user', text: 'Hello?' }],
        model: 'anthropic/claude-3.5-sonnet',
        canFile: true,
        repo: 'owner/repo',
      }),
    ).rejects.toThrow(/returned nothing/i)
  })
})
