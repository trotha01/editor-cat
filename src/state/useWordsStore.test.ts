/**
 * What the word pages promise about the two things a database is for: that an
 * edit is written down, and that a delete does not leave rubbish behind.
 *
 * Both are invisible on screen. A label picked from a menu looks exactly the
 * same whether or not it survived the tab being closed, and bytes with nothing
 * left pointing at them look like nothing at all — so a store that quietly
 * stopped saving, or quietly stopped clearing up, would go unnoticed until
 * somebody's storage was full of takes from a word they deleted last month.
 *
 * The selection rules are here for a smaller reason: a language and a word from
 * a different language is a state the page cannot draw, and every path that
 * changes a language has to settle the word too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetStore } from './useAssetStore'
import { useWordsStore } from './useWordsStore'
import type { Language, Tier, Word } from '../lib/words'
import type { Asset, AssetKind } from '../lib/types'

/** Every file handed to `ingestBlob`, in the order the store handed them over. */
const ingested: string[] = []

// Only the one call is stood in for: reading a file's duration means letting a
// browser decode it, which jsdom will not do — the promise would simply never
// settle. The rest of the module is what the ids below are made with.
vi.mock('../lib/media', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/media')>()
  return {
    ...original,
    ingestBlob: (blob: Blob, options: { kind: AssetKind; name: string }) => {
      ingested.push(options.name)
      return Promise.resolve({
        id: original.newId('asset'),
        kind: options.kind,
        blobKey: original.newId('blob'),
        mimeType: blob.type,
        name: options.name,
        createdAt: 0,
      } satisfies Asset)
    },
  }
})

const stored = {
  tiers: new Map<string, Tier>(),
  languages: new Map<string, Language>(),
  words: new Map<string, Word>(),
}
const deletedAssets: string[] = []

vi.mock('../lib/db', () => ({
  listTiers: () => Promise.resolve([...stored.tiers.values()]),
  putTier: (tier: Tier) => {
    stored.tiers.set(tier.id, tier)
    return Promise.resolve()
  },
  deleteTier: (id: string) => {
    stored.tiers.delete(id)
    return Promise.resolve()
  },
  listLanguages: () => Promise.resolve([...stored.languages.values()]),
  listWords: () => Promise.resolve([...stored.words.values()]),
  putLanguage: (language: Language) => {
    stored.languages.set(language.id, language)
    return Promise.resolve()
  },
  putWord: (word: Word) => {
    stored.words.set(word.id, word)
    return Promise.resolve()
  },
  deleteLanguage: (id: string) => {
    stored.languages.delete(id)
    return Promise.resolve()
  },
  deleteWord: (id: string) => {
    stored.words.delete(id)
    return Promise.resolve()
  },
  // Reached through the asset store, which is what actually clears the bytes.
  deleteAsset: (id: string) => {
    deletedAssets.push(id)
    return Promise.resolve()
  },
  putAsset: () => Promise.resolve(),
  getAsset: () => Promise.resolve(undefined),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

function asset(id: string): Asset {
  return { id, kind: 'video', blobKey: `blob_${id}`, mimeType: 'video/mp4', name: id, createdAt: 0 }
}

/** A file as a drop or a file input hands one over. */
function file(name: string, type: string): File {
  return new File(['take'], name, { type })
}

/** A store that has been read once, so `load` will not re-read over the test. */
function reset() {
  stored.tiers.clear()
  stored.languages.clear()
  stored.words.clear()
  deletedAssets.length = 0
  ingested.length = 0
  // The store writes the open selection down as the columns move, so without
  // this every test would open where the one before it left off.
  localStorage.clear()
  useAssetStore.setState({ assets: [], loading: false })
  useWordsStore.setState({
    tiers: [],
    languages: [],
    words: [],
    selectedTierId: null,
    selectedLanguageId: null,
    selectedWordId: null,
    loading: false,
    loaded: true,
    uploading: null,
    uploadError: null,
    past: [],
    future: [],
  })
  // Everything below is about languages and words, so the tier they hang from
  // is made once here rather than in every test.
  useWordsStore.getState().addTier('1st tier')
  // Which is scaffolding rather than something a test did, so it is not a step
  // any of them can take back.
  useWordsStore.setState({ past: [], future: [] })
}

beforeEach(reset)

describe('adding', () => {
  it('writes a new language down and opens it', () => {
    useWordsStore.getState().addLanguage('Spanish')

    const id = useWordsStore.getState().selectedLanguageId
    expect(id).not.toBeNull()
    expect(stored.languages.get(id!)?.name).toBe('Spanish')
  })

  it('selects the language already under that name rather than making a second', () => {
    useWordsStore.getState().addLanguage('Spanish')
    const first = useWordsStore.getState().selectedLanguageId

    useWordsStore.getState().addLanguage('  spanish')

    expect(useWordsStore.getState().languages).toHaveLength(1)
    expect(useWordsStore.getState().selectedLanguageId).toBe(first)
  })

  it('files a word under the open language, and opens that too', () => {
    useWordsStore.getState().addLanguage('Spanish')
    const languageId = useWordsStore.getState().selectedLanguageId

    useWordsStore.getState().addWord('gato')

    const wordId = useWordsStore.getState().selectedWordId
    expect(stored.words.get(wordId!)).toMatchObject({ text: 'gato', languageId, videos: [] })
  })

  it('refuses a word when no language is open, since there is nowhere to put it', () => {
    useWordsStore.getState().addWord('gato')

    expect(useWordsStore.getState().words).toEqual([])
  })
})

describe('selecting', () => {
  it('settles the word on the language that was just picked', () => {
    useWordsStore.getState().addLanguage('Spanish')
    const spanish = useWordsStore.getState().selectedLanguageId!
    useWordsStore.getState().addWord('gato')
    const gato = useWordsStore.getState().selectedWordId

    useWordsStore.getState().addLanguage('French')

    // A brand-new language has nothing in it, so nothing can be open.
    expect(useWordsStore.getState().selectedWordId).toBeNull()

    useWordsStore.getState().selectLanguage(spanish)
    expect(useWordsStore.getState().selectedWordId).toBe(gato)
  })
})

describe('editing a word’s videos', () => {
  function wordWithTwoVideos(): string {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('gato')
    const wordId = useWordsStore.getState().selectedWordId!
    useWordsStore.getState().addVideo(wordId, 'asset_a')
    useWordsStore.getState().addVideo(wordId, 'asset_b')
    return wordId
  }

  it('saves the order, the labels and the transcripts as they are set', () => {
    const wordId = wordWithTwoVideos()
    const [first, second] = useWordsStore.getState().selectedWord()!.videos

    useWordsStore.getState().setVideoRole(wordId, first!.id, 'intro')
    useWordsStore.getState().setTranscript(wordId, second!.id, 'el gato')
    useWordsStore.getState().moveVideo(wordId, 1, 0)

    // Read back out of storage rather than off the store, which is the whole
    // question: the screen is right either way.
    expect(stored.words.get(wordId)?.videos).toEqual([
      { id: second!.id, assetId: 'asset_b', role: 'word', transcript: 'el gato' },
      { id: first!.id, assetId: 'asset_a', role: 'intro' },
    ])
  })

  it('clears the bytes of a video nothing else lists', async () => {
    const wordId = wordWithTwoVideos()
    useAssetStore.setState({ assets: [asset('asset_a'), asset('asset_b')], loading: false })
    const [first] = useWordsStore.getState().selectedWord()!.videos

    await useWordsStore.getState().removeVideo(wordId, first!.id)

    expect(deletedAssets).toEqual(['asset_a'])
    expect(useAssetStore.getState().byId('asset_a')).toBeUndefined()
  })

  it('keeps the bytes when another word still plays the same take', async () => {
    const wordId = wordWithTwoVideos()
    useWordsStore.getState().addWord('perro')
    const other = useWordsStore.getState().selectedWordId!
    useWordsStore.getState().addVideo(other, 'asset_a')
    const [first] = useWordsStore.getState().words.find((entry) => entry.id === wordId)!.videos

    await useWordsStore.getState().removeVideo(wordId, first!.id)

    expect(deletedAssets).toEqual([])
  })
})

/**
 * Filing files from this machine, which is what both the upload button and a
 * drop onto a word end up calling.
 *
 * The order is the part worth asserting: the run is what the page exists to put
 * in order, so six takes handed over at once have to arrive in the order they
 * were handed over rather than in whichever order six ingests finished.
 */
describe('adding videos from this machine', () => {
  function openWord(): string {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('gato')
    return useWordsStore.getState().selectedWordId!
  }

  it('files them under the word, in the order they were handed over', async () => {
    const wordId = openWord()

    await useWordsStore
      .getState()
      .addLocalVideos(wordId, [
        file('intro.mp4', 'video/mp4'),
        file('gato.mp4', 'video/mp4'),
        file('outro.mp4', 'video/mp4'),
      ])

    expect(ingested).toEqual(['intro.mp4', 'gato.mp4', 'outro.mp4'])
    const names = stored.words
      .get(wordId)!
      .videos.map((video) => useAssetStore.getState().byId(video.assetId)?.name)
    expect(names).toEqual(['intro.mp4', 'gato.mp4', 'outro.mp4'])
    // Nothing is left claiming to be running, which is what the button and the
    // drop zones read to know they are free again.
    expect(useWordsStore.getState().uploading).toBeNull()
  })

  it('says which file was not a video and files the rest anyway', async () => {
    const wordId = openWord()

    await useWordsStore
      .getState()
      .addLocalVideos(wordId, [file('notes.pdf', 'application/pdf'), file('gato.mp4', 'video/mp4')])

    expect(useWordsStore.getState().uploadError).toContain('notes.pdf')
    expect(ingested).toEqual(['gato.mp4'])
    expect(stored.words.get(wordId)!.videos).toHaveLength(1)
  })

  it('refuses a second batch while one is running', async () => {
    const wordId = openWord()

    // Not awaited: the first batch is still in flight, which is exactly the
    // moment a second armful of files can be dropped on it.
    const running = useWordsStore.getState().addLocalVideos(wordId, [file('a.mp4', 'video/mp4')])
    await useWordsStore.getState().addLocalVideos(wordId, [file('b.mp4', 'video/mp4')])
    await running

    expect(ingested).toEqual(['a.mp4'])
  })
})

describe('deleting', () => {
  it('takes a word’s videos with it and moves on to the next word', async () => {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('perro')
    useWordsStore.getState().addWord('gato')
    const gato = useWordsStore.getState().selectedWordId!
    useWordsStore.getState().addVideo(gato, 'asset_a')

    await useWordsStore.getState().removeWord(gato)

    expect(stored.words.has(gato)).toBe(false)
    expect(deletedAssets).toEqual(['asset_a'])
    // The remaining word of that language, rather than nothing at all.
    expect(useWordsStore.getState().selectedWord()?.text).toBe('perro')
  })

  it('takes a language’s words with it', async () => {
    useWordsStore.getState().addLanguage('Spanish')
    const spanish = useWordsStore.getState().selectedLanguageId!
    useWordsStore.getState().addWord('gato')
    useWordsStore.getState().addVideo(useWordsStore.getState().selectedWordId!, 'asset_a')
    useWordsStore.getState().addLanguage('French')

    await useWordsStore.getState().removeLanguage(spanish)

    expect(stored.words.size).toBe(0)
    expect(deletedAssets).toEqual(['asset_a'])
    expect(useWordsStore.getState().languages.map((entry) => entry.name)).toEqual(['French'])
  })
})

/**
 * Taking an edit back.
 *
 * A step is the whole shelf, so what these are really asking is whether the
 * three lists, what is on screen and what is in storage all move together — a
 * word that comes back on screen and not in IndexedDB is a word that goes away
 * again on the next reload, which is worse than an undo that did nothing.
 */
describe('undo', () => {
  /** A language with two words in it, the second of which is open. */
  function twoWords(): { perro: string; gato: string } {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('perro')
    const perro = useWordsStore.getState().selectedWordId!
    useWordsStore.getState().addWord('gato')
    return { perro, gato: useWordsStore.getState().selectedWordId! }
  }

  function videosOf(wordId: string) {
    return useWordsStore.getState().words.find((word) => word.id === wordId)!.videos
  }

  it('has nothing to take back on a page nobody has edited', () => {
    expect(useWordsStore.getState().canUndo()).toBe(false)
    expect(useWordsStore.getState().canRedo()).toBe(false)
  })

  it('takes back the word that was just added, and a redo puts it back', () => {
    const { gato } = twoWords()

    useWordsStore.getState().undo()

    expect(useWordsStore.getState().words.map((word) => word.text)).toEqual(['perro'])
    expect(stored.words.has(gato)).toBe(false)
    // The word that is left, rather than the one that has gone.
    expect(useWordsStore.getState().selectedWord()?.text).toBe('perro')

    useWordsStore.getState().redo()

    expect(useWordsStore.getState().words.map((word) => word.text)).toEqual(['perro', 'gato'])
    expect(stored.words.get(gato)?.text).toBe('gato')
  })

  it('brings a deleted word back with its videos, in storage as well as on screen', async () => {
    const { gato } = twoWords()
    useWordsStore.getState().addVideo(gato, 'asset_a')
    useWordsStore.getState().setTranscript(gato, videosOf(gato)[0]!.id, 'el gato')

    await useWordsStore.getState().removeWord(gato)
    useWordsStore.getState().undo()

    expect(stored.words.get(gato)?.videos).toEqual([
      { id: expect.any(String), assetId: 'asset_a', role: 'word', transcript: 'el gato' },
    ])
    expect(useWordsStore.getState().words.map((word) => word.text)).toEqual(['perro', 'gato'])
    // The delete moved the page on to the word that was left, and the undo
    // leaves it there: a step never takes you somewhere else while what you are
    // looking at still exists, which is the rule the editor's undo follows too.
    expect(useWordsStore.getState().selectedWord()?.text).toBe('perro')
  })

  it('walks a run of edits back one at a time', () => {
    const { gato } = twoWords()
    useWordsStore.getState().renameWord(gato, 'gato - cat')
    useWordsStore.getState().addVideo(gato, 'asset_a')

    useWordsStore.getState().undo()
    expect(videosOf(gato)).toEqual([])

    useWordsStore.getState().undo()
    expect(useWordsStore.getState().words.find((word) => word.id === gato)?.text).toBe('gato')

    useWordsStore.getState().undo()
    expect(useWordsStore.getState().words.map((word) => word.text)).toEqual(['perro'])
  })

  it('records nothing for an edit that was refused', () => {
    useWordsStore.getState().addLanguage('Spanish')
    const spanish = useWordsStore.getState().selectedLanguageId!

    // Each of these is a no-op with a reason: the name is already taken, the
    // rename is to the name it has, and the word is not there to remove.
    useWordsStore.getState().addLanguage('  spanish')
    useWordsStore.getState().renameLanguage(spanish, 'Spanish')
    void useWordsStore.getState().removeWord('word_nothing')

    useWordsStore.getState().undo()

    expect(useWordsStore.getState().languages).toEqual([])
    expect(useWordsStore.getState().canUndo()).toBe(false)
  })

  it('folds a sentence typed into one transcript into one step', () => {
    const { gato } = twoWords()
    useWordsStore.getState().addVideo(gato, 'asset_a')
    const videoId = videosOf(gato)[0]!.id

    for (const typed of ['e', 'el', 'el g', 'el gato']) {
      useWordsStore.getState().setTranscript(gato, videoId, typed)
    }

    useWordsStore.getState().undo()

    // The whole sentence, rather than the last letter of it.
    expect(videosOf(gato)[0]?.transcript).toBeUndefined()
    // And the take itself is still there, so the step before it was the add.
    expect(videosOf(gato)).toHaveLength(1)
  })

  it('starts a new step when the typing moves to another take', () => {
    const { gato } = twoWords()
    useWordsStore.getState().addVideo(gato, 'asset_a')
    useWordsStore.getState().addVideo(gato, 'asset_b')
    const [first, second] = videosOf(gato)

    useWordsStore.getState().setTranscript(gato, first!.id, 'el gato')
    useWordsStore.getState().setTranscript(gato, second!.id, 'the cat')

    useWordsStore.getState().undo()

    expect(videosOf(gato)[1]?.transcript).toBeUndefined()
    expect(videosOf(gato)[0]?.transcript).toBe('el gato')
  })

  it('takes the typing back a sentence at a time after an undo, not a letter', () => {
    const { gato } = twoWords()
    useWordsStore.getState().addVideo(gato, 'asset_a')
    const videoId = videosOf(gato)[0]!.id
    useWordsStore.getState().setTranscript(gato, videoId, 'el gato')
    useWordsStore.getState().undo()

    // Typing again after an undo is a new thing to be able to take back, so the
    // step it starts must not be folded into the one that was just walked out of.
    useWordsStore.getState().setTranscript(gato, videoId, 'el perro')
    useWordsStore.getState().undo()

    expect(videosOf(gato)[0]?.transcript).toBeUndefined()
    expect(videosOf(gato)).toHaveLength(1)
  })

  it('leaves the bytes alone, since a redo — or another word — still wants them', () => {
    const { gato } = twoWords()
    useAssetStore.setState({ assets: [asset('asset_a')], loading: false })
    useWordsStore.getState().addVideo(gato, 'asset_a')

    useWordsStore.getState().undo()

    expect(deletedAssets).toEqual([])
    expect(useAssetStore.getState().byId('asset_a')).toBeDefined()
  })

  it('throws away what an undo backed out of as soon as something else is done', () => {
    const { gato } = twoWords()
    useWordsStore.getState().undo()
    expect(useWordsStore.getState().canRedo()).toBe(true)

    useWordsStore.getState().addWord('gata')

    expect(useWordsStore.getState().canRedo()).toBe(false)
    expect(useWordsStore.getState().words.map((word) => word.id)).not.toContain(gato)
  })
})

describe('load', () => {
  it('opens on the first of each column', async () => {
    // Out with the tier every other test starts from: this one is about what a
    // cold read opens on, so what is in storage has to be only its own.
    stored.tiers.clear()
    useWordsStore.setState({ loaded: false })
    stored.tiers.set('tier_esl', { id: 'tier_esl', name: 'ESL', createdAt: 0 })
    stored.tiers.set('tier_1', { id: 'tier_1', name: '1st tier', createdAt: 0 })
    stored.languages.set('lang_es', {
      id: 'lang_es',
      tierId: 'tier_1',
      name: 'Spanish',
      createdAt: 0,
    })
    stored.languages.set('lang_fr', {
      id: 'lang_fr',
      tierId: 'tier_1',
      name: 'French',
      createdAt: 0,
    })
    stored.words.set('w1', {
      id: 'w1',
      languageId: 'lang_fr',
      text: 'chien',
      videos: [],
      createdAt: 0,
    })

    await useWordsStore.getState().load()

    // "1st tier" and French, because each column is sorted by name rather than
    // by what was added first — what you see at the top is what opens.
    expect(useWordsStore.getState().selectedTierId).toBe('tier_1')
    expect(useWordsStore.getState().selectedLanguageId).toBe('lang_fr')
    expect(useWordsStore.getState().selectedWordId).toBe('w1')
  })

  it('leaves out a language saved before the shelf had tiers', async () => {
    stored.tiers.clear()
    useWordsStore.setState({ loaded: false })
    stored.tiers.set('tier_1', { id: 'tier_1', name: '1st tier', createdAt: 0 })
    // No tierId: written by a version whose languages sat at the root. Its
    // folder is still in Drive, which is where it can be moved under a tier.
    stored.languages.set('old', { id: 'old', name: 'Spanish', createdAt: 0 } as Language)

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().languages).toEqual([])
  })

  it('leaves the selection alone when the page is opened a second time', async () => {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('gato')
    useWordsStore.getState().addWord('perro')
    const perro = useWordsStore.getState().selectedWordId

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().selectedWordId).toBe(perro)
  })
})

/**
 * A refresh is how somebody comes back to a word after filming a take for it,
 * so the columns have to be where they were left rather than back at the top of
 * the shelf. Storage is checked directly here: what a reload reads is the whole
 * of what this does, and nothing on screen says whether it was written.
 */
describe('coming back after a reload', () => {
  const SELECTION_KEY = 'editor-cat.words.selection.v1'

  /** A shelf in storage with two tiers, two languages and a word under each. */
  function shelfInStorage() {
    stored.tiers.clear()
    // Out with the tier every other test starts from, and with the selection
    // adding it wrote down: this is a browser opening the page cold.
    localStorage.clear()
    stored.tiers.set('tier_esl', { id: 'tier_esl', name: 'ESL', createdAt: 0 })
    stored.tiers.set('tier_1', { id: 'tier_1', name: '1st tier', createdAt: 0 })
    stored.languages.set('lang_es', {
      id: 'lang_es',
      tierId: 'tier_1',
      name: 'Spanish',
      createdAt: 0,
    })
    stored.languages.set('lang_fr', {
      id: 'lang_fr',
      tierId: 'tier_1',
      name: 'French',
      createdAt: 0,
    })
    stored.words.set('w_helado', {
      id: 'w_helado',
      languageId: 'lang_es',
      text: 'helado',
      videos: [],
      createdAt: 0,
    })
    stored.words.set('w_chien', {
      id: 'w_chien',
      languageId: 'lang_fr',
      text: 'chien',
      videos: [],
      createdAt: 0,
    })
    useWordsStore.setState({ loaded: false })
  }

  function remember(selection: Record<string, string | null>) {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection))
  }

  it('writes the open columns down as they move', () => {
    useWordsStore.getState().addLanguage('Spanish')
    useWordsStore.getState().addWord('helado')

    const { selectedTierId, selectedLanguageId, selectedWordId } = useWordsStore.getState()
    expect(JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null')).toEqual({
      selectedTierId,
      selectedLanguageId,
      selectedWordId,
    })
  })

  it('opens on the remembered word rather than the first of each column', async () => {
    shelfInStorage()
    // Not what a cold read would pick: sorted by name, the first of each column
    // is "1st tier", French, chien.
    remember({
      selectedTierId: 'tier_1',
      selectedLanguageId: 'lang_es',
      selectedWordId: 'w_helado',
    })

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().selectedTierId).toBe('tier_1')
    expect(useWordsStore.getState().selectedLanguageId).toBe('lang_es')
    expect(useWordsStore.getState().selectedWordId).toBe('w_helado')
  })

  it('falls back to the first of a column whose remembered row has gone', async () => {
    shelfInStorage()
    // Deleted from another machine since this browser last had the page.
    remember({
      selectedTierId: 'tier_1',
      selectedLanguageId: 'lang_es',
      selectedWordId: 'w_deleted',
    })

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().selectedLanguageId).toBe('lang_es')
    expect(useWordsStore.getState().selectedWordId).toBe('w_helado')
  })

  it('keeps the remembered ids when this browser has no shelf yet', async () => {
    // Storage cleared, or a machine that has never had the page: the shelf is
    // about to arrive off the account, and settling against nothing would
    // forget where the user was before it got here.
    stored.tiers.clear()
    useWordsStore.setState({ loaded: false })
    remember({
      selectedTierId: 'tier_1',
      selectedLanguageId: 'lang_es',
      selectedWordId: 'w_helado',
    })

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().selectedWordId).toBe('w_helado')
  })

  it('opens on the first of each column when there is nothing remembered', async () => {
    shelfInStorage()

    await useWordsStore.getState().load()

    expect(useWordsStore.getState().selectedTierId).toBe('tier_1')
    expect(useWordsStore.getState().selectedLanguageId).toBe('lang_fr')
    expect(useWordsStore.getState().selectedWordId).toBe('w_chien')
  })
})
