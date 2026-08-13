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
  // Reached by the Settings dialog, which this page can open.
  estimateUsage: () => Promise.resolve(null),
  clearAll: () => Promise.resolve(),
  formatBytes: () => '0 B',
}))

/** Types a name into one of the three add boxes and presses its button. */
function add(label: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: label }))
}

/** The whole column a heading belongs to, rather than the row the heading is in. */
function column(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section')!
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
    past: [],
    future: [],
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

/**
 * The same two buttons the editor's header carries, doing the same job for the
 * other document this app edits.
 *
 * Asserted from the page rather than only from the store because the pair is
 * half state and half furniture: a button that works and is disabled is the same
 * as no button at all, and the shelf is edited from three columns at once, so
 * which of them a step came from must not matter.
 */
describe('undo and redo', () => {
  it('has nothing to offer until something has been done', () => {
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('takes the last edit back, and puts it back again', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')
    add('Add a word', 'chien')

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(within(column('Words')).queryByText('chien')).not.toBeInTheDocument()
    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))

    expect(within(column('Words')).getByText('chien')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('brings back a deleted language, with the words that went with it', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    add('Add a tier', '1st tier')
    add('Add a language', 'French')
    add('Add a word', 'chien')

    fireEvent.click(screen.getByRole('button', { name: 'Delete French' }))
    expect(within(column('Languages')).queryByText('French')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()
    expect(within(column('Words')).getByText('chien')).toBeInTheDocument()
  })

  it('answers Ctrl+Z, the same as the editor does', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    expect(within(column('Languages')).queryByText('French')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })

    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()
  })
})

describe('settings', () => {
  /**
   * The same dialog the editor opens, minus one section.
   *
   * Which is the whole point of it being the same dialog: the account and the
   * Drive folder the shelf lives in are as much this page's business as the
   * editor's. The project name is not — this page never opened a project, so
   * that field would name the empty document and typing in it would rename
   * something nobody chose.
   */
  it('opens the shared dialog, without the project name field', async () => {
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    // One of the sections that does belong here. The Drive one draws nothing
    // without a connection, which is what a test environment has.
    expect(screen.getByText('Stored media')).toBeInTheDocument()

    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument()
    expect(screen.queryByText('Project name')).not.toBeInTheDocument()
  })

  // It is the last control in the editor's header too. Settings is the one
  // button both pages have, so it is the one that has to be in the same place.
  it('sits last in the header', () => {
    // Links as well as buttons: what sat to the right of Settings here was the
    // link across to the editor.
    const controls = [...screen.getByRole('banner').querySelectorAll('button, a')]

    expect(controls.at(-1)).toHaveTextContent('Settings')
  })
})

describe('collapsing a column', () => {
  it('folds it to a strip and back, keeping what was open', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Tiers' }))

    // The list is still there — it is CSS that narrows the column, so what is
    // asserted is the button changing sides. What matters is that collapsing one
    // column does not disturb the two beside it.
    expect(screen.getByRole('button', { name: 'Expand Tiers' })).toBeInTheDocument()
    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Tiers' }))
    expect(screen.getByRole('button', { name: 'Collapse Tiers' })).toBeInTheDocument()
  })

  it('remembers which columns were folded', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Words' }))

    expect(window.localStorage.getItem('editor-cat.words.collapsedColumns.v1')).toContain('words')
  })
})

/**
 * The strip of buttons the narrow layout puts along the bottom of the window.
 *
 * Which list is open is CSS — jsdom applies none of it — so what is asserted is
 * the part that is not: each button says what is chosen at its level, and
 * `aria-expanded` says which list it opened. Both are also what a screen reader
 * has to go on, so testing them is not a proxy for the layout so much as the
 * other half of it.
 */
describe('the picker strip', () => {
  it('says what is chosen at each level, and follows the selection', () => {
    expect(screen.getByRole('button', { name: 'Tier: None chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Language: None chosen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Word: None chosen' })).toBeInTheDocument()

    add('Add a tier', '1st tier')
    add('Add a language', 'French')
    add('Add a word', 'chien')

    expect(screen.getByRole('button', { name: 'Tier: 1st tier' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Language: French' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Word: chien' })).toBeInTheDocument()
  })

  it('opens one list at a time, and closes the one that was open', () => {
    const tiers = screen.getByRole('button', { name: 'Tier: None chosen' })
    const languages = screen.getByRole('button', { name: 'Language: None chosen' })

    // Closed to start with: arriving at the page should be arriving at the
    // videos, not at a list of names covering them.
    expect(tiers).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(tiers)
    expect(tiers).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(languages)
    expect(tiers).toHaveAttribute('aria-expanded', 'false')
    expect(languages).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(languages)
    expect(languages).toHaveAttribute('aria-expanded', 'false')
  })

  it('moves on to the next level when one is picked, and gets out of the way at the last', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')
    add('Add a word', 'chien')
    add('Add a tier', 'ESL')

    fireEvent.click(screen.getByRole('button', { name: 'Tier: ESL' }))
    fireEvent.click(within(column('Tiers')).getByRole('button', { name: '1st tier' }))

    expect(screen.getByRole('button', { name: 'Tier: 1st tier' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Language: French' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    fireEvent.click(within(column('Languages')).getByRole('button', { name: 'French' }))
    expect(screen.getByRole('button', { name: 'Word: chien' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    fireEvent.click(within(column('Words')).getByRole('button', { name: 'chien' }))
    expect(screen.getByRole('button', { name: 'Word: chien' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('stays open while a run of words is being added', () => {
    add('Add a tier', '1st tier')
    add('Add a language', 'French')

    fireEvent.click(screen.getByRole('button', { name: 'Word: None chosen' }))
    add('Add a word', 'chien')

    expect(screen.getByRole('button', { name: 'Word: chien' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
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

  it('renames a language in place, and keeps its words', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rename French' }))

    const box = screen.getByRole('textbox', { name: 'Rename French' })
    fireEvent.change(box, { target: { value: 'Français' } })
    fireEvent.submit(box)

    expect(within(column('Languages')).getByText('Français')).toBeInTheDocument()
    expect(within(column('Languages')).queryByText('French')).not.toBeInTheDocument()
    expect(within(column('Words')).getByText('chien')).toBeInTheDocument()
  })

  it('throws the typing away on Escape', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rename French' }))

    const box = screen.getByRole('textbox', { name: 'Rename French' })
    fireEvent.change(box, { target: { value: 'Nonsense' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.blur(box)

    expect(within(column('Languages')).getByText('French')).toBeInTheDocument()
    expect(within(column('Languages')).queryByText('Nonsense')).not.toBeInTheDocument()
  })

  it('keeps the typing when the box loses focus, which is not a cancel', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Rename French' }))

    const box = screen.getByRole('textbox', { name: 'Rename French' })
    fireEvent.change(box, { target: { value: 'Français' } })
    fireEvent.blur(box)

    expect(within(column('Languages')).getByText('Français')).toBeInTheDocument()
  })

  it('adds nothing twice, whatever the case it is typed in', () => {
    add('Add a word', 'CHIEN')

    // By exact name: every row also carries a "Delete chien" button, which a
    // looser match would count as a second chien.
    expect(within(column('Words')).getAllByRole('button', { name: 'chien' })).toHaveLength(1)
  })
})
