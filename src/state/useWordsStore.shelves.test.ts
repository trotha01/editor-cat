import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShelfShare } from '../lib/supabase/shares'

/**
 * Opening one shelf rather than another, and what that costs the browser.
 *
 * The three IndexedDB stores hold one shelf between them and say nothing about
 * whose it is, so switching has to clear rather than merge. `mergeRemoteShelf`
 * is built to keep local rows the account has not heard about, which is exactly
 * the wrong instinct across a switch: it would graft one person's tiers onto
 * another's and then write the result back to them.
 *
 * The case that must *not* clear is the one that happens to everybody, every
 * time: the first sign-in of a visit, where the shelf goes from "this browser's"
 * to "this account's" without moving at all. Getting that wrong throws away a
 * shelf somebody built while signed out.
 */
const getShelf = vi.fn()
const putShelf = vi.fn()
const listShares = vi.fn()
const claimInvitations = vi.fn()
const deleteTier = vi.fn()
const deleteLanguage = vi.fn()
const deleteWord = vi.fn()

vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))
vi.mock('./useAuthStore', () => ({
  isSignedIn: () => true,
  currentSubject: () => 'google-oauth2|me',
}))
vi.mock('../lib/sync/assetSync', () => ({ recordAsset: () => Promise.resolve() }))

vi.mock('../lib/supabase/shelf', () => ({
  SHELF_SCHEMA_VERSION: 1,
  getShelf: (ownerId: string) => getShelf(ownerId) as unknown,
  putShelf: (doc: unknown, version: number | null, ownerId: string) =>
    putShelf(doc, version, ownerId) as unknown,
}))

vi.mock('../lib/supabase/shares', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/supabase/shares')>()),
  listShares: () => listShares() as unknown,
  claimInvitations: () => claimInvitations() as unknown,
}))

vi.mock('../lib/supabase/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/supabase/assets')>()),
  getAssets: () => Promise.resolve([]),
}))

vi.mock('../lib/db', () => ({
  listTiers: () => Promise.resolve([]),
  listLanguages: () => Promise.resolve([]),
  listWords: () => Promise.resolve([]),
  putTier: () => Promise.resolve(),
  putLanguage: () => Promise.resolve(),
  putWord: () => Promise.resolve(),
  deleteTier: (id: string) => deleteTier(id) as unknown,
  deleteLanguage: (id: string) => deleteLanguage(id) as unknown,
  deleteWord: (id: string) => deleteWord(id) as unknown,
  deleteAsset: () => Promise.resolve(),
  putAsset: () => Promise.resolve(),
  getAsset: () => Promise.resolve(undefined),
  getBlob: () => Promise.resolve(undefined),
  listAssets: () => Promise.resolve([]),
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const { useWordsStore } = await import('./useWordsStore')

const ME = 'google-oauth2|me'
const THEM = 'google-oauth2|them'

function share(extra: Partial<ShelfShare> = {}): ShelfShare {
  return {
    ownerId: THEM,
    memberEmail: 'me@example.com',
    memberId: ME,
    createdAt: '2026-08-01T00:00:00.000Z',
    claimedAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  }
}

/** A shelf with one tier on it, so a clear is something you can see happen. */
function shelfDoc(tierName: string) {
  return {
    tiers: [{ id: `tier_${tierName}`, name: tierName, createdAt: 0 }],
    languages: [],
    words: [],
  }
}

function localShelf() {
  useWordsStore.setState({
    tiers: [{ id: 'tier_local', name: 'Made here', createdAt: 0 }],
    languages: [],
    words: [],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  claimInvitations.mockResolvedValue(0)
  listShares.mockResolvedValue([])
  getShelf.mockResolvedValue(null)
  putShelf.mockResolvedValue(2)
  deleteTier.mockResolvedValue(undefined)
  deleteLanguage.mockResolvedValue(undefined)
  deleteWord.mockResolvedValue(undefined)
  useWordsStore.setState({
    tiers: [],
    languages: [],
    words: [],
    selectedTierId: null,
    selectedLanguageId: null,
    selectedWordId: null,
    loading: false,
    loaded: false,
    syncing: false,
    syncError: null,
    shelfOwnerId: null,
    shelves: [],
    uploading: null,
    uploadError: null,
    past: [],
    future: [],
  })
})

describe('working out which shelves there are', () => {
  it('claims an invitation before asking what there is to open', async () => {
    // Otherwise being invited is followed by being told to reload the page.
    await useWordsStore.getState().loadShelves()

    expect(claimInvitations).toHaveBeenCalled()
    expect(claimInvitations.mock.invocationCallOrder[0]!).toBeLessThan(
      listShares.mock.invocationCallOrder[0]!,
    )
  })

  it('offers your own shelf and every one shared with you', async () => {
    listShares.mockResolvedValue([share()])

    await useWordsStore.getState().loadShelves()

    expect(useWordsStore.getState().shelves.map((shelf) => shelf.ownerId)).toEqual([ME, THEM])
  })

  it('does not throw away a shelf built before signing in', async () => {
    // The case that happens to everybody: the shelf goes from "this browser's"
    // to "this account's" and has not moved at all.
    localShelf()

    await useWordsStore.getState().loadShelves()

    expect(useWordsStore.getState().shelfOwnerId).toBe(ME)
    expect(useWordsStore.getState().tiers).toHaveLength(1)
    expect(deleteTier).not.toHaveBeenCalled()
  })

  it('comes back to your own shelf when a share has been taken away', async () => {
    useWordsStore.setState({ shelfOwnerId: THEM })
    localShelf()
    listShares.mockResolvedValue([])

    await useWordsStore.getState().loadShelves()

    expect(useWordsStore.getState().shelfOwnerId).toBe(ME)
    // And the copy of theirs goes with it, rather than being merged into yours.
    expect(deleteTier).toHaveBeenCalledWith('tier_local')
    expect(useWordsStore.getState().tiers).toEqual([])
  })
})

describe('switching between them', () => {
  beforeEach(async () => {
    listShares.mockResolvedValue([share()])
    await useWordsStore.getState().loadShelves()
    vi.clearAllMocks()
    getShelf.mockResolvedValue(null)
  })

  it('reads the shelf it switched to, not the one it left', async () => {
    getShelf.mockResolvedValue({ doc: shelfDoc('Theirs'), version: 4 })

    await useWordsStore.getState().switchShelf(THEM)

    expect(getShelf).toHaveBeenCalledWith(THEM)
    expect(useWordsStore.getState().tiers.map((tier) => tier.name)).toEqual(['Theirs'])
  })

  it('clears this browser’s copy of the shelf it left', async () => {
    localShelf()

    await useWordsStore.getState().switchShelf(THEM)

    expect(deleteTier).toHaveBeenCalledWith('tier_local')
  })

  it('ignores a shelf this account was never let onto', async () => {
    await useWordsStore.getState().switchShelf('google-oauth2|stranger')

    expect(useWordsStore.getState().shelfOwnerId).toBe(ME)
    expect(getShelf).not.toHaveBeenCalled()
  })

  it('does nothing at all when asked for the shelf already open', async () => {
    await useWordsStore.getState().switchShelf(ME)
    expect(deleteTier).not.toHaveBeenCalled()
  })

  it('opens the same shelf again next time', async () => {
    await useWordsStore.getState().switchShelf(THEM)
    expect(localStorage.getItem('editor-cat.words.shelfOwner.v1')).toBe(THEM)
  })

  it('sends an unsaved edit up before leaving the shelf it was made on', async () => {
    // Shelf writes are debounced by more than a second, so switching within a
    // second of typing is not an unusual thing to do — and clearing the local
    // copy is what would make that edit unrecoverable.
    useWordsStore.getState().addTier('Classical')

    await useWordsStore.getState().switchShelf(THEM)

    expect(putShelf.mock.calls[0]?.[2]).toBe(ME)
  })

  it('does not write a shelf nobody changed just for leaving it', async () => {
    await useWordsStore.getState().switchShelf(THEM)
    expect(putShelf.mock.calls.map((call) => call[2])).toEqual([])
  })

  it('does not forget where you were on the shelf you left', async () => {
    // Emptying the columns wakes the subscriber that writes the selection down,
    // so this only holds if the owner moves before the clear does.
    useWordsStore.setState({ selectedTierId: 'tier_local' })

    await useWordsStore.getState().switchShelf(THEM)

    const remembered = localStorage.getItem('editor-cat.words.selection.v1')
    expect(JSON.parse(remembered!)).toMatchObject({ selectedTierId: 'tier_local' })
  })

  it('forgets the sync stamp of the shelf it left, not of the one it opens', async () => {
    // The stamp is what `mergeRemoteShelf` reads to decide which local rows the
    // account has never been told about. Left behind, it would describe a shelf
    // that is no longer here.
    localStorage.setItem('editor-cat.words.syncedAt.v1', '1723000000000')

    await useWordsStore.getState().switchShelf(THEM)

    expect(localStorage.getItem('editor-cat.words.syncedAt.v1')).toBeNull()
  })
})

describe('saving, once there is more than one shelf', () => {
  it('writes to the shelf that is open', async () => {
    listShares.mockResolvedValue([share()])
    await useWordsStore.getState().loadShelves()
    await useWordsStore.getState().switchShelf(THEM)

    useWordsStore.getState().addTier('Classical')
    await useWordsStore.getState().flushShelf()

    // The owner is the third argument, and it is the whole point of the call.
    expect(putShelf.mock.calls.map((call) => call[2])).toEqual([THEM])
  })

  /**
   * An account with no shelf row and a browser with a shelf is the migration:
   * everybody who used the page before it moved to the account is in that state
   * once, and saving is how it resolves. On somebody else's shelf the same
   * empty answer means something else entirely — they have not saved one, or
   * the share went away between the list and the read — and writing then would
   * put a cache of your words into their row.
   *
   * Both halves are here together because it is the *contrast* that is the
   * behaviour; either one alone would pass with the guard inverted.
   */
  describe('when the account has no shelf row at all', () => {
    async function settle(): Promise<void> {
      vi.useFakeTimers()
      try {
        await useWordsStore.getState().syncShelf()
        // Past SHELF_DELAY, so a write that was scheduled has actually gone.
        await vi.advanceTimersByTimeAsync(2000)
      } finally {
        vi.useRealTimers()
      }
    }

    it('writes this browser’s shelf up, when it is your own', async () => {
      await useWordsStore.getState().loadShelves()
      vi.clearAllMocks()
      getShelf.mockResolvedValue(null)
      putShelf.mockResolvedValue(1)
      localShelf()

      await settle()

      expect(putShelf.mock.calls.map((call) => call[2])).toEqual([ME])
    })

    it('leaves somebody else’s alone', async () => {
      listShares.mockResolvedValue([share()])
      await useWordsStore.getState().loadShelves()
      await useWordsStore.getState().switchShelf(THEM)
      vi.clearAllMocks()
      getShelf.mockResolvedValue(null)
      localShelf()

      await settle()

      expect(putShelf).not.toHaveBeenCalled()
    })
  })
})
