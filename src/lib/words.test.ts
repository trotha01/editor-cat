/**
 * The parts of the word pages that are arithmetic rather than screen.
 *
 * Two of these carry decisions worth pinning down rather than merely code worth
 * covering. The lists are sorted by name and not by when they were added, which
 * is what makes a column of two hundred words something you can find anything
 * in — and it is the sort of thing a later change "tidies" back to insertion
 * order without noticing. And a name typed a second time in a different case is
 * the same name, because the alternative is half of somebody's work filed under
 * "Spanish" and half under "spanish".
 */
import { describe, expect, it } from 'vitest'
import {
  findLanguage,
  findWord,
  isVideoAssetOrphaned,
  roleLabel,
  sortedLanguages,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type Language,
  type Word,
  type WordVideo,
} from './words'

function language(id: string, name: string): Language {
  return { id, name, createdAt: 0 }
}

function video(id: string, assetId: string): WordVideo {
  return { id, assetId, role: 'word' }
}

function word(id: string, languageId: string, text: string, videos: WordVideo[] = []): Word {
  return { id, languageId, text, videos, createdAt: 0 }
}

const SPANISH = language('lang_es', 'Spanish')
const FRENCH = language('lang_fr', 'French')

describe('the navigation lists', () => {
  it('sort languages by name without disturbing the stored order', () => {
    const stored = [SPANISH, FRENCH]

    expect(sortedLanguages(stored).map((entry) => entry.name)).toEqual(['French', 'Spanish'])
    expect(stored.map((entry) => entry.name)).toEqual(['Spanish', 'French'])
  })

  it('sort a language’s own words and leave every other language out', () => {
    const words = [
      word('w1', SPANISH.id, 'perro'),
      word('w2', FRENCH.id, 'chien'),
      word('w3', SPANISH.id, 'gato'),
    ]

    expect(wordsInLanguage(words, SPANISH.id).map((entry) => entry.text)).toEqual(['gato', 'perro'])
  })

  it('have nothing to show until a language is picked', () => {
    expect(wordsInLanguage([word('w1', SPANISH.id, 'gato')], null)).toEqual([])
  })
})

describe('adding something already there', () => {
  it('recognises a language whatever the case and spacing', () => {
    expect(findLanguage([SPANISH], '  spanish ')).toEqual(SPANISH)
    expect(findLanguage([SPANISH], 'Italian')).toBeUndefined()
  })

  it('recognises a word, but only inside its own language', () => {
    const words = [word('w1', SPANISH.id, 'gato')]

    expect(findWord(words, SPANISH.id, 'GATO')?.id).toBe('w1')
    // The same spelling under another language is a different word, and filing
    // it against Spanish because Spanish saw it first would be a real loss.
    expect(findWord(words, FRENCH.id, 'gato')).toBeUndefined()
  })
})

describe('a word’s run of videos', () => {
  const run = word('w1', SPANISH.id, 'gato', [
    video('v1', 'asset_a'),
    video('v2', 'asset_b'),
    video('v3', 'asset_c'),
  ])

  it('reorders without touching the rest of the word', () => {
    const moved = withMovedVideo(run, 2, 0)

    expect(moved.videos.map((entry) => entry.id)).toEqual(['v3', 'v1', 'v2'])
    expect(moved.text).toBe('gato')
    expect(run.videos.map((entry) => entry.id)).toEqual(['v1', 'v2', 'v3'])
  })

  it('leaves the order alone when asked to move past either end', () => {
    expect(withMovedVideo(run, 0, -1).videos.map((entry) => entry.id)).toEqual(['v1', 'v2', 'v3'])
    expect(withMovedVideo(run, 0, 3).videos.map((entry) => entry.id)).toEqual(['v1', 'v2', 'v3'])
  })

  it('adds to the end, so uploads arrive after what is already there', () => {
    expect(withVideo(run, video('v4', 'asset_d')).videos.at(-1)?.id).toBe('v4')
  })

  it('labels and transcribes one video at a time', () => {
    const patched = withVideoPatch(withVideoPatch(run, 'v1', { role: 'intro' }), 'v2', {
      transcript: 'el gato',
    })

    expect(patched.videos.map((entry) => entry.role)).toEqual(['intro', 'word', 'word'])
    expect(patched.videos.map((entry) => entry.transcript)).toEqual([
      undefined,
      'el gato',
      undefined,
    ])
  })

  it('drops one by id', () => {
    expect(withoutVideo(run, 'v2').videos.map((entry) => entry.id)).toEqual(['v1', 'v3'])
  })
})

describe('what a delete strands', () => {
  it('keeps bytes another word still plays, and only those', () => {
    const shared = [
      word('w1', SPANISH.id, 'gato', [video('v1', 'asset_a')]),
      word('w2', SPANISH.id, 'perro', [video('v2', 'asset_a'), video('v3', 'asset_b')]),
    ]

    expect(isVideoAssetOrphaned('asset_a', shared)).toBe(false)
    expect(isVideoAssetOrphaned('asset_b', shared)).toBe(false)
    expect(isVideoAssetOrphaned('asset_c', shared)).toBe(true)
  })
})

describe('roleLabel', () => {
  it('gives every role the name the picker shows', () => {
    expect([roleLabel('intro'), roleLabel('word'), roleLabel('outro')]).toEqual([
      'Intro',
      'Word',
      'Outro',
    ])
  })
})
