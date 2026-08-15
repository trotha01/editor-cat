import { describe, expect, it } from 'vitest'
import { resolveActiveShelf, shelfScopedKey, shelvesAvailable } from './shelves'
import type { ShelfShare } from './supabase/shares'

/**
 * Which shelf the word pages open on.
 *
 * Two of the three functions here exist because of things that go wrong rather
 * than things that go right: a share taken away while somebody was working on
 * it, and a storage key that has to keep meaning what it meant before shelves
 * could be shared. The second one is the quiet failure — a suffix on an existing
 * `syncedAt` reads as "never synced", which makes `mergeRemoteShelf` treat the
 * whole local shelf as work the account has not heard about.
 */

const ME = 'google-oauth2|me'
const THEM = 'google-oauth2|them'
const OTHER = 'google-oauth2|other'

function share(extra: Partial<ShelfShare>): ShelfShare {
  return {
    ownerId: THEM,
    memberEmail: 'me@example.com',
    memberId: ME,
    createdAt: '2026-08-01T00:00:00.000Z',
    claimedAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  }
}

describe('the shelves an account can open', () => {
  it('is just their own when nobody has shared one', () => {
    expect(shelvesAvailable([], ME)).toEqual([{ ownerId: ME, ownerEmail: null, mine: true }])
  })

  it('always offers their own, even on an account that has never saved', () => {
    // A shelf that does not exist yet is one save away from existing, and
    // leaving it out would strand somebody who was invited to another.
    const shelves = shelvesAvailable([share({})], ME)
    expect(shelves[0]).toEqual({ ownerId: ME, ownerEmail: null, mine: true })
  })

  it('adds a shelf for every claimed share', () => {
    const shelves = shelvesAvailable([share({ ownerId: THEM }), share({ ownerId: OTHER })], ME)
    expect(shelves.map((shelf) => shelf.ownerId)).toEqual([ME, OTHER, THEM])
  })

  it('leaves out an invitation nobody has claimed', () => {
    // It names an address rather than a subject, so no policy matches it yet:
    // opening it would be opening a shelf the database will not return.
    expect(shelvesAvailable([share({ memberId: null })], ME)).toHaveLength(1)
  })

  it('leaves out a share this account issued to somebody else', () => {
    // Both sides can see the row. Only one of them is being let onto a shelf.
    expect(shelvesAvailable([share({ ownerId: ME, memberId: THEM })], ME)).toHaveLength(1)
  })

  it('orders shared shelves the same way on every machine', () => {
    const forwards = shelvesAvailable([share({ ownerId: THEM }), share({ ownerId: OTHER })], ME)
    const backwards = shelvesAvailable([share({ ownerId: OTHER }), share({ ownerId: THEM })], ME)
    expect(forwards).toEqual(backwards)
  })
})

describe('settling on one of them', () => {
  const available = shelvesAvailable([share({ ownerId: THEM })], ME)

  it('keeps the one this browser was last on', () => {
    expect(resolveActiveShelf(THEM, available, ME)).toBe(THEM)
  })

  it('falls back to your own when the share has gone', () => {
    expect(resolveActiveShelf(OTHER, available, ME)).toBe(ME)
  })

  it('opens your own when nothing was remembered', () => {
    expect(resolveActiveShelf(null, available, ME)).toBe(ME)
  })
})

describe('storage keys, per shelf', () => {
  it('leaves your own shelf on the key it has always had', () => {
    // The load-bearing case. A browser that has been syncing for months has a
    // stamp under the bare key, and renaming it would read as "never synced".
    expect(shelfScopedKey('editor-cat.words.syncedAt.v1', ME, ME)).toBe(
      'editor-cat.words.syncedAt.v1',
    )
  })

  it('treats a signed-out browser as being on that same shelf', () => {
    // It is the shelf the account will call its own the moment somebody signs
    // in, so a sign-in must not look like a switch.
    expect(shelfScopedKey('base', null, null)).toBe('base')
    expect(shelfScopedKey('base', null, ME)).toBe('base')
  })

  it('gives somebody else’s shelf a key of its own', () => {
    expect(shelfScopedKey('base', THEM, ME)).toBe(`base.shelf:${THEM}`)
  })

  it('keeps two shared shelves apart', () => {
    expect(shelfScopedKey('base', THEM, ME)).not.toBe(shelfScopedKey('base', OTHER, ME))
  })
})
