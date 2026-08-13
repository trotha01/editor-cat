/**
 * The three navigation columns, and the rule that ties them together.
 *
 * A tier, then a language taught in it, then a word of that language: each
 * column is always about whatever the one to its left has open, and there is no
 * state where it is showing somebody else's languages or words. That is easy to
 * break from any side — a delete, a new tier, a stale selection — and it matters
 * most where two tiers teach the same language, which is two shelves that happen
 * to share a name. So it is asserted from the page rather than only from the
 * store, where the three columns are just three ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { WordsPage } from './WordsPage'
import { useAssetStore } from './state/useAssetStore'
import { useWordsStore } from './state/useWordsStore'

vi.mock('./lib/db', () => ({
  putTier: () => Promise.resolve(),
  deleteTier: () => Promise.resolve(),
  listTiers: () => Promise.resolve([]),
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

/** Types a name into one of the three add boxes and presses its button. */
function add(label: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: label }))
}

function column(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).parentElement!
}

beforeEach(() => {
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
    syncing: false,
    syncError: null,
  })
  render(<WordsPage />)
})

// The confirm stub two of these install must not answer the next test's
// question — or its absence of one.
afterEach(() => vi.restoreAllMocks())

describe('starting from nothing', () => {
  it('asks for each column in turn before it will take the next', () => {
    expect(screen.getByRole('textbox', { name: 'Add a language' })).toBeDisabled()
    expect(screen.getByText('Pick a tier first.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Add a word' })).toBeDisabled()
    expect(screen.getByText('Pick a language first.')).toBeInTheDocument()
  })

  it('opens the word and its videos once all three have been added', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')
    add('Add a word', 'cerville - brain')

    expect(screen.getByRole('heading', { name: 'cerville - brain' })).toBeInTheDocument()
    expect(screen.getByText('1st tier · French')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload videos' })).toBeInTheDocument()
    expect(screen.getByText('No videos for this word yet')).toBeInTheDocument()
  })
})

describe('the columns to the right of a tier', () => {
  beforeEach(() => {
    add('Add a tier', '1st tier')
    add('Add a language', 'Spanish')
    add('Add a word', 'gato')
    add('Add a language', 'French')
    add('Add a word', 'chien')
  })

  it('shows only the languages of the tier that is open', () => {
    add('Add a tier', 'ESL')

    expect(within(column('Languages')).queryByText('Spanish')).not.toBeInTheDocument()
    expect(within(column('Words')).queryByText('gato')).not.toBeInTheDocument()

    fireEvent.click(within(column('Tiers')).getByRole('button', { name: '1st tier' }))

    expect(within(column('Languages')).getByText('Spanish')).toBeInTheDocument()
  })

  it('keeps two tiers’ copies of the same language apart', () => {
    add('Add a tier', 'ESL')
    add('Add a language', 'French')
    add('Add a word', 'bonjour - hello')

    expect(within(column('Words')).getByText('bonjour - hello')).toBeInTheDocument()
    expect(within(column('Words')).queryByText('chien')).not.toBeInTheDocument()

    fireEvent.click(within(column('Tiers')).getByRole('button', { name: '1st tier' }))
    fireEvent.click(within(column('Languages')).getByRole('button', { name: 'French' }))

    expect(within(column('Words')).getByText('chien')).toBeInTheDocument()
    expect(within(column('Words')).queryByText('bonjour - hello')).not.toBeInTheDocument()
  })

  it('shows only the words of the language that is open', () => {
    expect(within(column('Words')).getByText('chien')).toBeInTheDocument()
    expect(within(column('Words')).queryByText('gato')).not.toBeInTheDocument()

    fireEvent.click(within(column('Languages')).getByRole('button', { name: 'Spanish' }))

    expect(within(column('Words')).getByText('gato')).toBeInTheDocument()
    expect(within(column('Words')).queryByText('chien')).not.toBeInTheDocument()
  })

  it('follows the language back to whatever is left when one is deleted', () => {
    // Deleting a language takes its words with it, so it asks first — and a
    // test that did not answer would silently be testing a delete that never
    // happened.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: 'Delete French' }))

    expect(confirm).toHaveBeenCalledWith('Delete "French" and its 1 word?')
    expect(within(column('Languages')).queryByText('French')).not.toBeInTheDocument()
    expect(within(column('Words')).getByText('gato')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'gato' })).toBeInTheDocument()
  })

  it('leaves a language alone when the question is answered no', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    fireEvent.click(screen.getByRole('button', { name: 'Delete French' }))

    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()
  })

  it('adds nothing twice, whatever the case it is typed in', () => {
    add('Add a word', 'CHIEN')

    // By exact name: every row also carries a "Delete chien" button, which a
    // looser match would count as a second chien.
    expect(within(column('Words')).getAllByRole('button', { name: 'chien' })).toHaveLength(1)
  })
})
