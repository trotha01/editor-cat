/**
 * The screen a word's videos are ordered and labelled on.
 *
 * Ordering is the reason the page exists, and it is the one control here that
 * has two ways in: a drag handle and a pair of buttons. The buttons are what a
 * keyboard has and what a test can press, so they are what is asserted — a drag
 * that stopped working would still be caught by the store test underneath both
 * of them, but a pair of arrows that silently stopped moving anything would not
 * be caught anywhere else.
 *
 * The missing-file row is asserted because it is the state nobody develops
 * against: the videos are listed in this browser and their bytes are cached in
 * it, so a word opened on a second machine is a run of rows with nothing behind
 * them, and drawing those as blanks would look like the takes had been lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { WordVideos } from './WordVideos'
import { useAssetStore } from '../state/useAssetStore'
import { useWordsStore } from '../state/useWordsStore'
import type { Asset } from '../lib/types'
import type { Word } from '../lib/words'

vi.mock('../lib/db', () => ({
  putWord: () => Promise.resolve(),
  putLanguage: () => Promise.resolve(),
  deleteWord: () => Promise.resolve(),
  deleteLanguage: () => Promise.resolve(),
  listWords: () => Promise.resolve([]),
  listLanguages: () => Promise.resolve([]),
  putAsset: () => Promise.resolve(),
  deleteAsset: () => Promise.resolve(),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

function asset(id: string, name: string): Asset {
  return {
    id,
    kind: 'video',
    blobKey: `blob_${id}`,
    mimeType: 'video/mp4',
    name,
    duration: 4,
    createdAt: 0,
  }
}

const WORD: Word = {
  id: 'word_gato',
  languageId: 'lang_es',
  text: 'gato',
  videos: [
    { id: 'v1', assetId: 'asset_a', role: 'intro', transcript: 'Ready?' },
    { id: 'v2', assetId: 'asset_b', role: 'word' },
  ],
  createdAt: 0,
}

/** The word as the store holds it now, which is what every edit is checked against. */
function current(): Word {
  return useWordsStore.getState().words.find((entry) => entry.id === WORD.id)!
}

function mount(word: Word = WORD) {
  useWordsStore.setState({
    tiers: [{ id: 'tier_1', name: '1st tier', createdAt: 0 }],
    languages: [{ id: 'lang_es', tierId: 'tier_1', name: 'Spanish', createdAt: 0 }],
    words: [word],
    selectedTierId: 'tier_1',
    selectedLanguageId: 'lang_es',
    selectedWordId: word.id,
    loading: false,
    loaded: true,
  })
  const view = render(<WordVideos word={word} />)
  return {
    // The page re-renders from the store in the real app; here the prop is
    // passed in, so an edit has to be handed back the same way to be seen.
    rerender: () => view.rerender(<WordVideos word={current()} />),
    // The player's own element, which is the first on the page — it is drawn
    // above the list, and the rest are the thumbnails on the rows.
    player: () => view.container.querySelector('video')!,
  }
}

beforeEach(() => {
  useAssetStore.setState({
    assets: [asset('asset_a', 'intro.mp4'), asset('asset_b', 'gato.mp4')],
    loading: false,
  })
})

describe('the run of videos', () => {
  it('lists them in the order they play, numbered', () => {
    mount()

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).getByText('intro.mp4')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('1')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('gato.mp4')).toBeInTheDocument()
  })

  it('moves one later, and moves it back', () => {
    const { rerender } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Move intro.mp4 later' }))
    expect(current().videos.map((video) => video.assetId)).toEqual(['asset_b', 'asset_a'])

    rerender()
    fireEvent.click(screen.getByRole('button', { name: 'Move intro.mp4 earlier' }))
    expect(current().videos.map((video) => video.assetId)).toEqual(['asset_a', 'asset_b'])
  })

  it('offers no way off either end of the run', () => {
    mount()

    expect(screen.getByRole('button', { name: 'Move intro.mp4 earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move gato.mp4 later' })).toBeDisabled()
  })

  it('labels a video intro, word or outro', () => {
    mount()

    const label = screen.getByRole('combobox', { name: 'Label for gato.mp4' })
    expect(label).toHaveValue('word')

    fireEvent.change(label, { target: { value: 'outro' } })
    expect(current().videos[1]?.role).toBe('outro')
  })

  it('attaches a transcript to one video without touching the others', () => {
    mount()

    fireEvent.change(screen.getByRole('textbox', { name: 'Transcript for gato.mp4' }), {
      target: { value: 'el gato' },
    })

    expect(current().videos.map((video) => video.transcript)).toEqual(['Ready?', 'el gato'])
  })

  it('takes one out of the run', () => {
    mount()

    fireEvent.click(screen.getByRole('button', { name: 'Remove intro.mp4' }))

    expect(current().videos.map((video) => video.id)).toEqual(['v2'])
  })

  it('says so when this browser does not hold the file', () => {
    useAssetStore.setState({ assets: [asset('asset_b', 'gato.mp4')], loading: false })
    mount()

    expect(screen.getByText('The file for this one is not on this machine.')).toBeInTheDocument()
    // Still a row, still countable: two videos are listed and one of them is
    // simply not here.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('watching them together', () => {
  it('opens on the first video and says how much there is', () => {
    mount()

    expect(screen.getByText('1 of 2 · Intro · intro.mp4')).toBeInTheDocument()
    expect(screen.getByText(/2 videos · 0:08/)).toBeInTheDocument()
  })

  it('shows the transcript of whatever is on screen, and moves on', () => {
    mount()

    // As a line under the picture, as against the same words in the box that is
    // there to edit them — both are on screen, and this is the reading copy.
    expect(screen.getByText('Ready?', { selector: 'p' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next video' }))

    expect(screen.getByText('2 of 2 · Word · gato.mp4')).toBeInTheDocument()
    expect(screen.getByText('No transcript for this one yet.')).toBeInTheDocument()
  })

  /**
   * The one rule in the player that is not obvious from reading it.
   *
   * A media element that reaches the end of its file pauses itself and fires
   * `pause` *before* it fires `ended` — verified in Chromium, and what the spec
   * says. So by the time the run is asked what to play next it has already been
   * stopped underneath it, and a player that merely leaves its own state alone
   * plays exactly one take per press. Both halves are asserted from the events
   * the browser really sends, in the order it really sends them.
   */
  it('carries on into the next take through the pause the browser fires at the end', () => {
    const { player } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play all' }))
    fireEvent.pause(player())
    fireEvent.ended(player())

    expect(screen.getByText('2 of 2 · Word · gato.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('stops and rewinds when the last take ends', () => {
    const { player } = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Play all' }))
    fireEvent.pause(player())
    fireEvent.ended(player())
    fireEvent.pause(player())
    fireEvent.ended(player())

    expect(screen.getByText('1 of 2 · Intro · intro.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play all' })).toBeInTheDocument()
  })

  it('is not drawn at all for a word with nothing uploaded yet', () => {
    mount({ ...WORD, videos: [] })

    expect(screen.queryByRole('button', { name: 'Play all' })).not.toBeInTheDocument()
    expect(screen.getByText('No videos for this word yet')).toBeInTheDocument()
  })
})
