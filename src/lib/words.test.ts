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
  mergeShelf,
  parseShelfDoc,
  parseSidecar,
  roleLabel,
  sortedTiers,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type DiscoveredLanguage,
  type DiscoveredTier,
  type DiscoveredWord,
  type Language,
  type Tier,
  type Word,
  type WordSidecar,
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
describe('reading the shelf back out of Drive', () => {
  const found = (
    languageName: string,
    folderId: string,
    words: DiscoveredWord[],
  ): DiscoveredLanguage => ({ folderId, name: languageName, words })

  const foundWord = (
    name: string,
    folderId: string,
    videos: { driveFileId: string; assetId: string }[],
    sidecar: WordSidecar | null = null,
  ): DiscoveredWord => ({ folderId, name, videos, sidecar })

  /** Wraps discovered languages in the one tier most of these tests are about. */
  const inTier = (languages: DiscoveredLanguage[]): DiscoveredTier[] => [
    { folderId: 'folder_first', name: '1st tier', languages },
  ]

  /** A shelf with the first tier already on it, which is where the local ones start. */
  const withFirst = (languages: Language[], words: Word[]) => ({
    tiers: [{ ...FIRST, driveFolderId: 'folder_first' }],
    languages,
    words,
  })

  /** Every take of these tests has been uploaded, unless a test says otherwise. */
  const uploaded = (map: Record<string, string>) => (assetId: string) => map[assetId]

  it('brings a whole shelf onto a machine that has never seen it', () => {
    const merged = mergeShelf(
      { tiers: [], languages: [], words: [] },
      inTier([
        found('Spanish', 'folder_es', [
          foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
        ]),
      ]),
      uploaded({ asset_a: 'f1' }),
    )

    expect(merged.languages).toHaveLength(1)
    expect(merged.languages[0]).toMatchObject({ name: 'Spanish', driveFolderId: 'folder_es' })
    expect(merged.words[0]).toMatchObject({
      text: 'gato',
      driveFolderId: 'folder_gato',
      languageId: merged.languages[0]!.id,
    })
    expect(merged.words[0]?.videos).toEqual([
      { id: expect.any(String) as string, assetId: 'asset_a', role: 'word' },
    ])
  })

  it('adopts the folder of a language added here before Drive was reachable', () => {
    const local = withFirst([SPANISH], [word('w1', SPANISH.id, 'gato')])

    const merged = mergeShelf(
      local,
      inTier([found('spanish', 'folder_es', [foundWord('GATO', 'folder_gato', [])])]),
      () => undefined,
    )

    // The same language and the same word, now knowing where they live — not a
    // second pair under a different capital.
    expect(merged.languages).toHaveLength(1)
    expect(merged.languages[0]).toMatchObject({ id: SPANISH.id, driveFolderId: 'folder_es' })
    expect(merged.words).toHaveLength(1)
    expect(merged.words[0]).toMatchObject({ id: 'w1', driveFolderId: 'folder_gato' })
  })

  it('is not fooled into a duplicate by reading the same shelf twice', () => {
    const discovered = inTier([
      found('Spanish', 'folder_es', [
        foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
      ]),
    ])
    const driveIds = uploaded({ asset_a: 'f1' })

    const once = mergeShelf({ tiers: [], languages: [], words: [] }, discovered, driveIds)
    const twice = mergeShelf(once, discovered, driveIds)

    expect(twice.languages).toHaveLength(1)
    expect(twice.words).toHaveLength(1)
    expect(twice.words[0]?.videos).toEqual(once.words[0]?.videos)
  })

  it('takes the order, the labels and the transcripts from the sidecar', () => {
    const sidecar: WordSidecar = {
      version: 1,
      word: 'gato',
      videos: [
        { driveFileId: 'f2', role: 'intro', transcript: 'Ready?' },
        { driveFileId: 'f1', role: 'word' },
      ],
    }

    const merged = mergeShelf(
      { tiers: [], languages: [], words: [] },
      inTier([
        found('Spanish', 'folder_es', [
          foundWord(
            'gato',
            'folder_gato',
            // Drive lists them the other way about, which is exactly the point:
            // the folder says what there is, the sidecar says what order.
            [
              { driveFileId: 'f1', assetId: 'asset_a' },
              { driveFileId: 'f2', assetId: 'asset_b' },
            ],
            sidecar,
          ),
        ]),
      ]),
      uploaded({ asset_a: 'f1', asset_b: 'f2' }),
    )

    expect(merged.words[0]?.videos.map((entry) => entry.assetId)).toEqual(['asset_b', 'asset_a'])
    expect(merged.words[0]?.videos[0]).toMatchObject({ role: 'intro', transcript: 'Ready?' })
  })

  it('puts a video dropped into the folder by hand at the end of the run', () => {
    const sidecar: WordSidecar = {
      version: 1,
      word: 'gato',
      videos: [{ driveFileId: 'f1', role: 'intro' }],
    }

    const merged = mergeShelf(
      { tiers: [], languages: [], words: [] },
      inTier([
        found('Spanish', 'folder_es', [
          foundWord(
            'gato',
            'folder_gato',
            [
              { driveFileId: 'f1', assetId: 'asset_a' },
              { driveFileId: 'f_phone', assetId: 'asset_phone' },
            ],
            sidecar,
          ),
        ]),
      ]),
      uploaded({ asset_a: 'f1', asset_phone: 'f_phone' }),
    )

    expect(merged.words[0]?.videos.map((entry) => entry.assetId)).toEqual([
      'asset_a',
      'asset_phone',
    ])
    // Nothing to say what it is, so it is what most takes are.
    expect(merged.words[0]?.videos[1]?.role).toBe('word')
  })

  it('drops a take whose file has gone from the folder, and keeps one still uploading', () => {
    const local = withFirst(
      [{ ...SPANISH, driveFolderId: 'folder_es' }],
      [
        {
          ...word('w1', SPANISH.id, 'gato', [
            video('v_deleted', 'asset_deleted'),
            video('v_uploading', 'asset_uploading'),
          ]),
          driveFolderId: 'folder_gato',
        },
      ],
    )

    const merged = mergeShelf(
      local,
      inTier([found('Spanish', 'folder_es', [foundWord('gato', 'folder_gato', [])])]),
      // The first was uploaded and is no longer in the folder — deleted from
      // another machine. The second has no Drive file yet, so its absence there
      // says nothing at all.
      uploaded({ asset_deleted: 'f_gone' }),
    )

    expect(merged.words[0]?.videos.map((entry) => entry.assetId)).toEqual(['asset_uploading'])
  })

  it('drops a word deleted from another machine, and the language with it', () => {
    const local = withFirst(
      [
        { ...SPANISH, driveFolderId: 'folder_es' },
        { ...FRENCH, driveFolderId: 'folder_fr' },
      ],
      [
        { ...word('w1', SPANISH.id, 'gato'), driveFolderId: 'folder_gato' },
        { ...word('w2', SPANISH.id, 'perro'), driveFolderId: 'folder_perro' },
        { ...word('w3', FRENCH.id, 'chien'), driveFolderId: 'folder_chien' },
      ],
    )

    const merged = mergeShelf(
      local,
      // French is gone entirely, and Spanish has lost "perro".
      inTier([found('Spanish', 'folder_es', [foundWord('gato', 'folder_gato', [])])]),
      () => undefined,
    )

    expect(merged.languages.map((entry) => entry.name)).toEqual(['Spanish'])
    expect(merged.words.map((entry) => entry.text)).toEqual(['gato'])
  })

  it('keeps two tiers apart, even where they teach the same language', () => {
    const merged = mergeShelf(
      { tiers: [], languages: [], words: [] },
      [
        {
          folderId: 'folder_first',
          name: '1st tier',
          languages: [found('French', 'folder_fr_1', [foundWord('cerville - brain', 'w_a', [])])],
        },
        {
          folderId: 'folder_esl',
          name: 'ESL',
          languages: [found('French', 'folder_fr_esl', [foundWord('bonjour - hello', 'w_b', [])])],
        },
      ],
      () => undefined,
    )

    expect(merged.tiers.map((entry) => entry.name)).toEqual(['1st tier', 'ESL'])
    // Two French folders under two tiers are two languages, not one seen twice —
    // and each keeps its own words.
    expect(merged.languages).toHaveLength(2)
    expect(merged.languages.map((entry) => entry.tierId)).toEqual([
      merged.tiers[0]!.id,
      merged.tiers[1]!.id,
    ])
    expect(merged.words.map((entry) => entry.text)).toEqual(['cerville - brain', 'bonjour - hello'])
  })

  it('drops a tier deleted elsewhere, and everything filed under it', () => {
    const local = {
      tiers: [
        { ...FIRST, driveFolderId: 'folder_first' },
        { ...ESL, driveFolderId: 'folder_esl' },
      ],
      languages: [
        { ...SPANISH, driveFolderId: 'folder_es' },
        { ...language('lang_de', 'German', ESL.id), driveFolderId: 'folder_de' },
      ],
      words: [
        { ...word('w1', SPANISH.id, 'gato'), driveFolderId: 'folder_gato' },
        { ...word('w2', 'lang_de', 'hund - dog'), driveFolderId: 'folder_hund' },
      ],
    }

    const merged = mergeShelf(
      local,
      inTier([found('Spanish', 'folder_es', [foundWord('gato', 'folder_gato', [])])]),
      () => undefined,
    )

    expect(merged.tiers.map((entry) => entry.name)).toEqual(['1st tier'])
    expect(merged.languages.map((entry) => entry.name)).toEqual(['Spanish'])
    expect(merged.words.map((entry) => entry.text)).toEqual(['gato'])
  })

  it('keeps what was added here while Drive was out of reach', () => {
    const local = {
      // No folder ids: made on this machine, and Drive has never heard of them.
      tiers: [FIRST],
      languages: [SPANISH],
      words: [word('w1', SPANISH.id, 'gato', [video('v1', 'asset_a')])],
    }

    const merged = mergeShelf(local, [], () => undefined)

    expect(merged.tiers).toEqual([FIRST])
    expect(merged.languages).toEqual([SPANISH])
    expect(merged.words[0]?.videos).toHaveLength(1)
  })

  it('keeps the row a take is already on, so a sync mid-edit does not move it', () => {
    const local = withFirst(
      [{ ...SPANISH, driveFolderId: 'folder_es' }],
      [
        {
          ...word('w1', SPANISH.id, 'gato', [{ id: 'v1', assetId: 'asset_a', role: 'outro' }]),
          driveFolderId: 'folder_gato',
        },
      ],
    )

    const merged = mergeShelf(
      local,
      inTier([
        found('Spanish', 'folder_es', [
          foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
        ]),
      ]),
      uploaded({ asset_a: 'f1' }),
    )

    // Same id, and the label this browser has — nothing over there said otherwise.
    expect(merged.words[0]?.videos).toEqual([{ id: 'v1', assetId: 'asset_a', role: 'outro' }])
  })
})

describe('the old file beside a word’s videos', () => {
  it('treats a file that has been mangled as one that is not there', () => {
    expect(parseSidecar('not json at all')).toBeNull()
    expect(parseSidecar('{"version":1}')).toBeNull()
    expect(parseSidecar('[]')).toBeNull()
  })

  it('keeps what it can of a file with a bad entry in it', () => {
    const parsed = parseSidecar(
      JSON.stringify({
        version: 1,
        word: 'gato',
        videos: [{ role: 'intro' }, { driveFileId: 'f1', role: 'nonsense' }],
      }),
    )

    // The entry with no file is unusable and goes; the one with an unknown label
    // is a real take that simply gets the ordinary one.
    expect(parsed?.videos).toEqual([{ driveFileId: 'f1', role: 'word' }])
  })
})

/**
 * The shelf as the account holds it.
 *
 * Two of these are the whole reason the shelf moved off Drive and out of a file
 * per word, and both only break somewhere expensive: a read that quietly drops
 * work made offline, and a read that quietly brings back a word somebody deleted
 * on their other machine. They pull in opposite directions, which is what makes
 * "since the last successful write" the line between them rather than a
 * preference for one of the two copies.
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
      [{ ...FIRST, driveFolderId: 'folder_first' }],
      [{ ...SPANISH, driveFolderId: 'folder_es' }],
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
