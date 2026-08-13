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
import type { Asset } from '../lib/types'

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
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

function asset(id: string): Asset {
  return { id, kind: 'video', blobKey: `blob_${id}`, mimeType: 'video/mp4', name: id, createdAt: 0 }
}

/** A store that has been read once, so `load` will not re-read over the test. */
function reset() {
  stored.tiers.clear()
  stored.languages.clear()
  stored.words.clear()
  deletedAssets.length = 0
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
  })
  // Everything below is about languages and words, so the tier they hang from
  // is made once here rather than in every test.
  useWordsStore.getState().addTier('1st tier')
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
