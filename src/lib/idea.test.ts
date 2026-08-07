import { describe, expect, it } from 'vitest'
import { appendWord, firstSentence, parseSuggestions, tokenize } from './idea'

/**
 * The parser is the whole risk in this step. Everything the Idea tab shows
 * comes back as prose from a model that was asked for a list and is under no
 * obligation to comply, so each case below is a shape one has actually been
 * seen to answer in. Rejecting any of them would look, from the outside, like
 * the feature simply not working.
 */
describe('parseSuggestions', () => {
  it('reads the plain shape it asked for', () => {
    const raw = 'currit — runs\nlatrat — barks'

    expect(parseSuggestions(raw)).toEqual([
      { text: 'currit', gloss: 'runs' },
      { text: 'latrat', gloss: 'barks' },
    ])
  })

  it('keeps entries that came with no gloss at all', () => {
    expect(parseSuggestions('currit\nlatrat')).toEqual([{ text: 'currit' }, { text: 'latrat' }])
  })

  it('strips the bullets and numbering it was told not to use', () => {
    const raw = '1. currit — runs\n- latrat — barks\n• dormit — sleeps\n2) sedet'

    expect(parseSuggestions(raw).map((s) => s.text)).toEqual([
      'currit',
      'latrat',
      'dormit',
      'sedet',
    ])
  })

  it('drops the heading a model puts above the list', () => {
    expect(parseSuggestions('Here are six verbs:\ncurrit — runs')).toEqual([
      { text: 'currit', gloss: 'runs' },
    ])
  })

  it('strips code fences', () => {
    expect(parseSuggestions('```\ncurrit — runs\n```')).toEqual([{ text: 'currit', gloss: 'runs' }])
  })

  it('accepts the other separators models reach for', () => {
    const raw = 'currit – runs\nlatrat - barks\ndormit: sleeps\nsedet (sits)'

    expect(parseSuggestions(raw)).toEqual([
      { text: 'currit', gloss: 'runs' },
      { text: 'latrat', gloss: 'barks' },
      { text: 'dormit', gloss: 'sleeps' },
      { text: 'sedet', gloss: 'sits' },
    ])
  })

  it('keeps a hyphen that is part of the word', () => {
    // The spaced form is a separator; this one is spelling.
    expect(parseSuggestions('sun-drenched — bathed in light')).toEqual([
      { text: 'sun-drenched', gloss: 'bathed in light' },
    ])
  })

  it('falls back to commas when the answer arrives on one line', () => {
    expect(parseSuggestions('currit, latrat, dormit').map((s) => s.text)).toEqual([
      'currit',
      'latrat',
      'dormit',
    ])
  })

  it('does not split sentences on their commas', () => {
    const raw = 'Canis currit, et puer ridet.'

    expect(parseSuggestions(raw, { sentences: true })).toEqual([{ text: raw }])
  })

  it('unwraps quoted entries without eating quotes inside them', () => {
    expect(parseSuggestions('"currit"\n')).toEqual([{ text: 'currit' }])
    expect(parseSuggestions('signum — a sign reading "OPEN"')).toEqual([
      { text: 'signum', gloss: 'a sign reading "OPEN"' },
    ])
  })

  it('takes the full stop off a word but leaves it on a sentence', () => {
    expect(parseSuggestions('currit.')).toEqual([{ text: 'currit' }])
    expect(parseSuggestions('Canis currit.', { sentences: true })).toEqual([
      { text: 'Canis currit.' },
    ])
  })

  it('holds each idea to the one sentence the step is about', () => {
    const raw = 'Canis in horto dormit. Sol ardet. — The dog sleeps in the garden.'

    expect(parseSuggestions(raw, { sentences: true })).toEqual([
      { text: 'Canis in horto dormit.', gloss: 'The dog sleeps in the garden.' },
    ])
  })

  it('drops repeats, which is what a model does when it runs out of ideas', () => {
    expect(parseSuggestions('currit — runs\nCurrit — runs fast\nlatrat')).toEqual([
      { text: 'currit', gloss: 'runs' },
      { text: 'latrat' },
    ])
  })

  it('stops at the limit rather than showing however many arrived', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `word${i}`).join('\n')

    expect(parseSuggestions(raw, { limit: 4 })).toHaveLength(4)
  })

  it('returns nothing for an empty or unusable answer, so the caller can say so', () => {
    expect(parseSuggestions('')).toEqual([])
    expect(parseSuggestions('\n\n  \n')).toEqual([])
  })
})

describe('firstSentence', () => {
  it('cuts at the first full stop', () => {
    expect(firstSentence('Canis currit. Puer ridet.')).toBe('Canis currit.')
  })

  it('handles a question or an exclamation', () => {
    expect(firstSentence('Ubi est canis? In horto.')).toBe('Ubi est canis?')
    expect(firstSentence('Ecce canis! Currit.')).toBe('Ecce canis!')
  })

  it('leaves a lone sentence, punctuated or not, alone', () => {
    expect(firstSentence('Canis in horto dormit')).toBe('Canis in horto dormit')
    expect(firstSentence('Canis in horto dormit.')).toBe('Canis in horto dormit.')
  })

  it('keeps a closing quote with the sentence it belongs to', () => {
    expect(firstSentence('"Canis currit." Puer ridet.')).toBe('"Canis currit."')
  })
})

describe('tokenize', () => {
  it('renders back to exactly what it was given', () => {
    const sentence = '  Canis, in horto — dormit!  '

    expect(
      tokenize(sentence)
        .map((token) => token.text)
        .join(''),
    ).toBe(sentence)
  })

  it('marks the words and only the words as pickable', () => {
    expect(
      tokenize('Canis currit.')
        .filter((token) => token.word)
        .map((token) => token.text),
    ).toEqual(['Canis', 'currit'])
  })

  it('keeps a word whole across accents, apostrophes and hyphens', () => {
    // The default language is not English, and neither is most of the list.
    const words = (sentence: string) =>
      tokenize(sentence)
        .filter((token) => token.word)
        .map((token) => token.text)

    expect(words("aujourd'hui il pleut")).toEqual(["aujourd'hui", 'il', 'pleut'])
    expect(words('μῆλον χρυσοῦν')).toEqual(['μῆλον', 'χρυσοῦν'])
    expect(words('un chien sans-abri')).toEqual(['un', 'chien', 'sans-abri'])
  })

  it('gives repeated words distinct indexes, so picking one picks one', () => {
    const picked = tokenize('canis videt canem').filter((token) => token.word)

    expect(picked.map((token) => token.index)).toEqual([0, 2, 4])
  })

  it('has nothing to pick in an empty sentence', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('appendWord', () => {
  it('adds a suggestion to the end of what is there', () => {
    expect(appendWord('canis', 'currit')).toBe('canis currit')
  })

  it('starts the sentence when there is nothing yet', () => {
    expect(appendWord('   ', 'canis')).toBe('canis')
  })

  it('reopens a sentence that had been closed off', () => {
    // Suggestions get picked while the sentence is still being assembled, and
    // "Canis currit. hortus" is nobody's idea.
    expect(appendWord('Canis currit.', 'in horto')).toBe('Canis currit in horto')
  })

  it('ignores an empty suggestion rather than adding a space', () => {
    expect(appendWord('canis', '  ')).toBe('canis')
  })
})
