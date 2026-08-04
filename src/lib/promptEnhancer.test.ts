import { describe, expect, it } from 'vitest'
import { stripWrapping } from './promptEnhancer'

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
