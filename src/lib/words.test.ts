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
  buildShelfDoc,
  findLanguage,
  findWord,
  isVideoAssetOrphaned,
  languagesInTier,
  mergeRemoteShelf,
  parseShelfDoc,
  roleInRun,
  roleLabel,
  sortedTiers,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type Language,
  type Tier,
  type Word,
  type WordVideo,
} from './words'

function tier(id: string, name: string): Tier {
  return { id, name, createdAt: 0 }
}

function language(id: string, name: string, tierId = FIRST.id): Language {
  return { id, tierId, name, createdAt: 0 }
}

function video(id: string, assetId: string): WordVideo {
  return { id, assetId, role: 'word' }
}

function word(id: string, languageId: string, text: string, videos: WordVideo[] = []): Word {
  return { id, languageId, text, videos, createdAt: 0 }
}

const FIRST = tier('tier_1', '1st tier')
const ESL = tier('tier_esl', 'ESL')
const SPANISH = language('lang_es', 'Spanish')
const FRENCH = language('lang_fr', 'French')

describe('the navigation lists', () => {
  it('sort tiers by name without disturbing the stored order', () => {
    const stored = [ESL, FIRST]

    expect(sortedTiers(stored).map((entry) => entry.name)).toEqual(['1st tier', 'ESL'])
    expect(stored.map((entry) => entry.name)).toEqual(['ESL', '1st tier'])
  })

  it('sort a tier’s own languages and leave every other tier out', () => {
    const languages = [
      language('l1', 'Spanish'),
      language('l2', 'German', ESL.id),
      language('l3', 'French'),
    ]

    expect(languagesInTier(languages, FIRST.id).map((entry) => entry.name)).toEqual([
      'French',
      'Spanish',
    ])
  })

  it('have no languages to show until a tier is picked', () => {
    expect(languagesInTier([language('l1', 'Spanish')], null)).toEqual([])
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
  it('recognises a language whatever the case and spacing, inside its own tier', () => {
    expect(findLanguage([SPANISH], FIRST.id, '  spanish ')).toEqual(SPANISH)
    expect(findLanguage([SPANISH], FIRST.id, 'Italian')).toBeUndefined()
    // Spanish in ESL is a different shelf from Spanish in the first tier.
    expect(findLanguage([SPANISH], ESL.id, 'Spanish')).toBeUndefined()
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

/**
 * The rule the whole of the labelling now rests on, so it is pinned down here
 * rather than only through the screen that draws it: the ends of a run are its
 * intro and its outro because they are the ends, and moving a take is the only
 * thing that can make one.
 */
describe('the label a take wears where it sits', () => {
  const run = [video('v1', 'asset_a'), video('v2', 'asset_b'), video('v3', 'asset_c')]

  it('reads the ends off the order, whatever is stored on them', () => {
    expect(run.map((entry, index) => roleInRun(entry, index, run.length))).toEqual([
      'intro',
      'word',
      'outro',
    ])
  })

  it('follows a take dragged to the front', () => {
    const moved = withMovedVideo(word('w1', SPANISH.id, 'gato', run), 2, 0).videos

    expect(moved.map((entry, index) => roleInRun(entry, index, moved.length))).toEqual([
      'intro',
      'word',
      'outro',
    ])
    // The same take, and it is the intro now purely by being first.
    expect(moved[0]?.id).toBe('v3')
  })

  it('leaves an intro dragged inwards saying nothing rather than saying intro', () => {
    const stored: WordVideo = { id: 'v1', assetId: 'asset_a', role: 'intro' }

    expect(roleInRun(stored, 1, 3)).toBeUndefined()
  })

  it('gives the takes in between whatever label they carry, if any', () => {
    expect(roleInRun({ id: 'v2', assetId: 'asset_b', role: 'word' }, 1, 3)).toBe('word')
    expect(roleInRun({ id: 'v2', assetId: 'asset_b' }, 1, 3)).toBeUndefined()
  })

  it('makes a run of one neither end of anything', () => {
    expect(roleInRun(video('v1', 'asset_a'), 0, 1)).toBe('word')
    expect(roleInRun({ id: 'v1', assetId: 'asset_a' }, 0, 1)).toBeUndefined()
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

/**
 * The shelf as Drive holds it, and folding it back in.
 *
 * This is where the whole Drive story is either true or subtly broken, and every
 * way it can be broken looks the same from a distance — a word that turns up
 * twice, an order that resets, a take that comes back from the dead a week after
 * it was deleted. So the awkward cases are pinned down here rather than left to
 * be discovered on somebody's second machine.
 */
describe('the shelf on the account', () => {
  const shelf = (tiers: Tier[], languages: Language[], words: Word[]) => ({
    tiers,
    languages,
    words,
  })

  /** A row made at a given moment, which is what the merge sorts on. */
  const madeAt = <T extends { createdAt: number }>(entry: T, createdAt: number): T => ({
    ...entry,
    createdAt,
  })

  it('reads back exactly what it wrote', () => {
    const local = shelf(
      [{ ...FIRST }],
      [{ ...SPANISH }],
      [
        word('w1', SPANISH.id, 'gato', [
          { id: 'v1', assetId: 'asset_a', role: 'outro', transcript: 'el gato' },
        ]),
      ],
    )

    expect(parseShelfDoc(JSON.parse(JSON.stringify(buildShelfDoc(local))))).toEqual(local)
  })

  it('is an empty shelf when the document is nonsense, which is what a new account is', () => {
    expect(parseShelfDoc(null)).toEqual({ tiers: [], languages: [], words: [] })
    expect(parseShelfDoc('not a shelf')).toEqual({ tiers: [], languages: [], words: [] })
    expect(parseShelfDoc({ tiers: 'no' })).toEqual({ tiers: [], languages: [], words: [] })
  })

  it('drops an entry with nothing to identify it by, and keeps the rest', () => {
    const parsed = parseShelfDoc({
      tiers: [FIRST, { name: 'No id' }],
      languages: [SPANISH, { id: 'lang_x', name: 'No tier' }],
      words: [
        {
          ...word('w1', SPANISH.id, 'gato'),
          videos: [{ assetId: 'asset_a' }, video('v1', 'asset_a')],
        },
      ],
    })

    expect(parsed.tiers).toEqual([FIRST])
    expect(parsed.languages).toEqual([SPANISH])
    // A take with no id of its own cannot be re-ordered, renamed or removed, so
    // it is not a row this page could draw.
    expect(parsed.words[0]?.videos).toEqual([video('v1', 'asset_a')])
  })

  it('takes the account’s copy of the shelf over this browser’s', () => {
    const remote = shelf(
      [FIRST],
      [SPANISH],
      [word('w1', SPANISH.id, 'gato', [video('v1', 'asset_a')])],
    )
    const local = shelf(
      [FIRST],
      [SPANISH],
      // The same word, as it was before somebody re-ordered it elsewhere.
      [word('w1', SPANISH.id, 'gato', [video('v2', 'asset_b'), video('v1', 'asset_a')])],
    )

    const merged = mergeRemoteShelf(remote, local, 100)

    expect(merged.words[0]?.videos).toEqual([video('v1', 'asset_a')])
  })

  it('lets a word deleted on another machine stay deleted', () => {
    // A browser that has agreed with the account before: everything it holds
    // from before then has been up there, so an absence is a deletion.
    const local = shelf([FIRST], [SPANISH], [madeAt(word('w1', SPANISH.id, 'gato'), 50)])

    const merged = mergeRemoteShelf(shelf([FIRST], [SPANISH], []), local, 100)

    expect(merged.words).toEqual([])
  })

  it('keeps a word made here since the last write, which the account has not been told about', () => {
    const offline = madeAt(word('w2', SPANISH.id, 'perro'), 150)
    const local = shelf([FIRST], [SPANISH], [madeAt(word('w1', SPANISH.id, 'gato'), 50), offline])

    const merged = mergeRemoteShelf(shelf([FIRST], [SPANISH], []), local, 100)

    expect(merged.words).toEqual([offline])
  })

  it('drops a fresh word whose language the account no longer has', () => {
    // Deleting a language deletes its words, and a word added here a moment
    // before that reached us is still one of its words.
    const local = shelf(
      [FIRST],
      [madeAt(SPANISH, 50)],
      [madeAt(word('w1', SPANISH.id, 'gato'), 150)],
    )

    const merged = mergeRemoteShelf(shelf([FIRST], [], []), local, 100)

    expect(merged.languages).toEqual([])
    expect(merged.words).toEqual([])
  })
})
