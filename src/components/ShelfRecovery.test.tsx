import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The panel that puts unreachable word takes back.
 *
 * The interesting behaviour is what it says *after* a run. Shelf writes are
 * debounced and every repair resets the timer, so the account's copy is behind
 * the moment the run returns — and a count taken then reports takes that were
 * repaired seconds ago. That reads exactly like real leftover damage, which is
 * why it is worth a test rather than a comment.
 */
const unreachableWords = vi.fn()
const recoverShelf = vi.fn()
const flushShelf = vi.fn()
const repairVideo = vi.fn()

/** Every call the panel makes to the account or the shelf, in order. */
let calls: string[] = []

vi.mock('../lib/r2/recoverShelf', () => ({
  unreachableWords: () => {
    calls.push('count')
    return unreachableWords() as unknown
  },
  recoverShelf: (options: unknown) => {
    calls.push('recover')
    return recoverShelf(options) as unknown
  },
}))

vi.mock('../lib/google/connection', () => ({
  connectionStatus: () => Promise.resolve({ durable: true, connected: true }),
}))
vi.mock('../lib/auth0/client', () => ({ connectDrive: () => Promise.resolve() }))
vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))

vi.mock('../state/useWordsStore', () => ({
  useWordsStore: (selector: (state: unknown) => unknown) =>
    selector({
      repairVideo,
      flushShelf: () => {
        calls.push('flush')
        return flushShelf() as unknown
      },
    }),
}))

const { ShelfRecovery } = await import('./ShelfRecovery')

const WORD = {
  wordId: 'w1',
  text: 'Caelestis - Heavenly',
  tier: 'Classical',
  language: 'Latin',
  takes: [{ id: 'wv1', assetId: 'asset_1' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  unreachableWords.mockResolvedValue([WORD])
  flushShelf.mockResolvedValue(undefined)
  recoverShelf.mockResolvedValue({
    recovered: 1,
    words: [{ word: WORD.text, recovered: 1 }],
  })
})

describe('before anything has been done', () => {
  it('offers to recover what cannot be played', async () => {
    render(<ShelfRecovery />)

    expect(await screen.findByRole('button', { name: /recover 1 take/i })).toBeInTheDocument()
  })

  it('says nothing at all when every take can be reached', async () => {
    unreachableWords.mockResolvedValue([])
    const { container } = render(<ShelfRecovery />)

    await waitFor(() => expect(unreachableWords).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

describe('after a run', () => {
  it('writes the shelf up before asking what is left', async () => {
    // The whole point. Counting first reads the account partway through the
    // run and reports takes that are already fixed.
    render(<ShelfRecovery />)
    fireEvent.click(await screen.findByRole('button', { name: /recover 1 take/i }))

    await waitFor(() => expect(recoverShelf).toHaveBeenCalled())
    await waitFor(() => expect(calls.filter((call) => call === 'count')).toHaveLength(2))

    // count (on mount), recover, flush, count — the flush sits between the run
    // and the count that reports the result.
    expect(calls).toEqual(['count', 'recover', 'flush', 'count'])
  })

  it('reports each word, including any it left alone', async () => {
    // Per word rather than in aggregate: a skipped word needs naming, because
    // the reason is usually something only the person can settle.
    recoverShelf.mockResolvedValue({
      recovered: 1,
      words: [
        { word: 'Caelestis - Heavenly', recovered: 1 },
        { word: 'Iterum - Again', recovered: 0, skipped: 'Its Drive folder has no videos in it.' },
      ],
    })
    unreachableWords.mockResolvedValueOnce([WORD]).mockResolvedValueOnce([])

    render(<ShelfRecovery />)
    fireEvent.click(await screen.findByRole('button', { name: /recover 1 take/i }))

    expect(await screen.findByText(/Iterum - Again/)).toBeInTheDocument()
    expect(screen.getByText(/no videos in it/)).toBeInTheDocument()
  })

  it('stops offering once there is nothing left', async () => {
    unreachableWords.mockResolvedValueOnce([WORD]).mockResolvedValueOnce([])

    render(<ShelfRecovery />)
    fireEvent.click(await screen.findByRole('button', { name: /recover 1 take/i }))

    await screen.findByText(/Recovered 1 take/)
    expect(screen.queryByRole('button', { name: /recover/i })).not.toBeInTheDocument()
  })
})
