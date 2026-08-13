/**
 * The two navigation columns, and the rule that ties them together.
 *
 * A language, then a word of that language: the second column is always about
 * whatever the first one has open, and there is no state where it is showing
 * somebody else's words. That is easy to break from either side — a delete, a
 * new language, a stale selection — so it is asserted from the page rather than
 * only from the store, where the two columns are just two ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { WordsPage } from './WordsPage'
import { useAssetStore } from './state/useAssetStore'
import { useWordsStore } from './state/useWordsStore'

vi.mock('./lib/db', () => ({
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

/** Types a name into one of the two add boxes and presses its button. */
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
    languages: [],
    words: [],
    selectedLanguageId: null,
    selectedWordId: null,
    loading: false,
    loaded: true,
  })
  render(<WordsPage />)
})

// The confirm stub two of these install must not answer the next test's
// question — or its absence of one.
afterEach(() => vi.restoreAllMocks())

describe('starting from nothing', () => {
  it('asks for a language before it will take a word', () => {
    expect(screen.getByRole('textbox', { name: 'Add a word' })).toBeDisabled()
    expect(screen.getByText('Pick a language first.')).toBeInTheDocument()
  })

  it('opens the word and its videos once both have been added', () => {
    add('Add a language', 'Spanish')
    add('Add a word', 'gato')

    expect(screen.getByRole('heading', { name: 'gato' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload videos' })).toBeInTheDocument()
    expect(screen.getByText('No videos for this word yet')).toBeInTheDocument()
  })
})

describe('the second column', () => {
  beforeEach(() => {
    add('Add a language', 'Spanish')
    add('Add a word', 'gato')
    add('Add a language', 'French')
    add('Add a word', 'chien')
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
