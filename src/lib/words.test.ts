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
  buildSidecar,
  findLanguage,
  findWord,
  isVideoAssetOrphaned,
  mergeShelf,
  parseSidecar,
  roleLabel,
  sortedLanguages,
  withMovedVideo,
  withVideo,
  withVideoPatch,
  withoutVideo,
  wordsInLanguage,
  type DiscoveredLanguage,
  type DiscoveredWord,
  type Language,
  type Word,
  type WordSidecar,
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

  /** Every take of these tests has been uploaded, unless a test says otherwise. */
  const uploaded = (map: Record<string, string>) => (assetId: string) => map[assetId]

  it('brings a whole shelf onto a machine that has never seen it', () => {
    const merged = mergeShelf(
      { languages: [], words: [] },
      [
        found('Spanish', 'folder_es', [
          foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
        ]),
      ],
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
    const local = { languages: [SPANISH], words: [word('w1', SPANISH.id, 'gato')] }

    const merged = mergeShelf(
      local,
      [found('spanish', 'folder_es', [foundWord('GATO', 'folder_gato', [])])],
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
    const discovered = [
      found('Spanish', 'folder_es', [
        foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
      ]),
    ]
    const driveIds = uploaded({ asset_a: 'f1' })

    const once = mergeShelf({ languages: [], words: [] }, discovered, driveIds)
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
      { languages: [], words: [] },
      [
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
      ],
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
      { languages: [], words: [] },
      [
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
      ],
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
    const local = {
      languages: [{ ...SPANISH, driveFolderId: 'folder_es' }],
      words: [
        {
          ...word('w1', SPANISH.id, 'gato', [
            video('v_deleted', 'asset_deleted'),
            video('v_uploading', 'asset_uploading'),
          ]),
          driveFolderId: 'folder_gato',
        },
      ],
    }

    const merged = mergeShelf(
      local,
      [found('Spanish', 'folder_es', [foundWord('gato', 'folder_gato', [])])],
      // The first was uploaded and is no longer in the folder — deleted from
      // another machine. The second has no Drive file yet, so its absence there
      // says nothing at all.
      uploaded({ asset_deleted: 'f_gone' }),
    )

    expect(merged.words[0]?.videos.map((entry) => entry.assetId)).toEqual(['asset_uploading'])
  })

  it('drops a word deleted from another machine, and the language with it', () => {
    const local = {
      languages: [
        { ...SPANISH, driveFolderId: 'folder_es' },
        { ...FRENCH, driveFolderId: 'folder_fr' },
      ],
      words: [
        { ...word('w1', SPANISH.id, 'gato'), driveFolderId: 'folder_gato' },
        { ...word('w2', SPANISH.id, 'perro'), driveFolderId: 'folder_perro' },
        { ...word('w3', FRENCH.id, 'chien'), driveFolderId: 'folder_chien' },
      ],
    }

    const merged = mergeShelf(
      local,
      // French is gone entirely, and Spanish has lost "perro".
      [found('Spanish', 'folder_es', [foundWord('gato', 'folder_gato', [])])],
      () => undefined,
    )

    expect(merged.languages.map((entry) => entry.name)).toEqual(['Spanish'])
    expect(merged.words.map((entry) => entry.text)).toEqual(['gato'])
  })

  it('keeps what was added here while Drive was out of reach', () => {
    const local = {
      // No folder ids: made on this machine, and Drive has never heard of them.
      languages: [SPANISH],
      words: [word('w1', SPANISH.id, 'gato', [video('v1', 'asset_a')])],
    }

    const merged = mergeShelf(local, [], () => undefined)

    expect(merged.languages).toEqual([SPANISH])
    expect(merged.words[0]?.videos).toHaveLength(1)
  })

  it('keeps the row a take is already on, so a sync mid-edit does not move it', () => {
    const local = {
      languages: [{ ...SPANISH, driveFolderId: 'folder_es' }],
      words: [
        {
          ...word('w1', SPANISH.id, 'gato', [{ id: 'v1', assetId: 'asset_a', role: 'outro' }]),
          driveFolderId: 'folder_gato',
        },
      ],
    }

    const merged = mergeShelf(
      local,
      [
        found('Spanish', 'folder_es', [
          foundWord('gato', 'folder_gato', [{ driveFileId: 'f1', assetId: 'asset_a' }]),
        ]),
      ],
      uploaded({ asset_a: 'f1' }),
    )

    // Same id, and the label this browser has — nothing over there said otherwise.
    expect(merged.words[0]?.videos).toEqual([{ id: 'v1', assetId: 'asset_a', role: 'outro' }])
  })
})

describe('the file written beside a word’s videos', () => {
  it('names the takes by their Drive file, in the order they play', () => {
    const run = word('w1', SPANISH.id, 'gato', [
      { id: 'v1', assetId: 'asset_a', role: 'intro', transcript: ' Ready? ' },
      { id: 'v2', assetId: 'asset_b', role: 'word' },
    ])

    expect(buildSidecar(run, (id) => ({ asset_a: 'f1', asset_b: 'f2' })[id])).toEqual({
      version: 1,
      word: 'gato',
      videos: [
        { driveFileId: 'f1', role: 'intro', transcript: 'Ready?' },
        { driveFileId: 'f2', role: 'word' },
      ],
    })
  })

  it('leaves out a take that has nothing in Drive to name it by', () => {
    const run = word('w1', SPANISH.id, 'gato', [video('v1', 'asset_uploading')])

    expect(buildSidecar(run, () => undefined).videos).toEqual([])
  })

  it('reads its own writing back', () => {
    const run = word('w1', SPANISH.id, 'gato', [
      { id: 'v1', assetId: 'asset_a', role: 'outro', transcript: 'el gato' },
    ])
    const written = buildSidecar(run, () => 'f1')

    expect(parseSidecar(JSON.stringify(written))).toEqual(written)
  })

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
