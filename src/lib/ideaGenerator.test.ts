import { describe, expect, it } from 'vitest'
import { IDEA_COUNT, parseIdeas } from './ideaGenerator'

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
    const text = '1. A raccoon files a noise complaint.\n2. A toaster interviews for a job.\n3. Done.'
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
})

describe('IDEA_COUNT', () => {
  it('is the number of ideas requested from the model', () => {
    expect(IDEA_COUNT).toBe(20)
  })
})
