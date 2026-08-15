import { describe, expect, it } from 'vitest'
import {
  invitationsAwaiting,
  looksLikeEmail,
  normaliseEmail,
  sharesIssuedBy,
  shelvesJoinedBy,
  type ShelfShare,
} from './shares'

/**
 * Sorting one query's worth of share rows into the three things they mean.
 *
 * A single select comes back with everything row-level security will show this
 * account — shares they issued, shelves they were let onto, and invitations
 * still waiting for their address — because that is one round trip rather than
 * three that could disagree with each other halfway through. The cost is that
 * something has to tell them apart, and getting it wrong shows a shelf that
 * cannot be opened or hides one that can.
 *
 * The address helpers are here for a smaller reason with a sharper edge: the
 * column has a check constraint saying it is lowercase, and the claim matches on
 * it, so an address written as typed is an invitation nobody can ever accept.
 */

const ME = 'google-oauth2|me'
const THEM = 'google-oauth2|them'

function share(extra: Partial<ShelfShare>): ShelfShare {
  return {
    ownerId: ME,
    memberEmail: 'someone@example.com',
    memberId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    claimedAt: null,
    ...extra,
  }
}

describe('normalising an address', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Someone@Example.COM ')).toBe('someone@example.com')
  })

  it('accepts an address that looks like one', () => {
    expect(looksLikeEmail('someone@example.com')).toBe(true)
    expect(looksLikeEmail('  Someone@Example.com  ')).toBe(true)
  })

  it('refuses a name, a blank, or a half-typed address', () => {
    expect(looksLikeEmail('')).toBe(false)
    expect(looksLikeEmail('Jo')).toBe(false)
    expect(looksLikeEmail('jo@')).toBe(false)
    expect(looksLikeEmail('jo@example')).toBe(false)
    expect(looksLikeEmail('two@addresses@example.com')).toBe(false)
  })
})

describe('telling the three kinds of row apart', () => {
  const rows = [
    share({ ownerId: ME, memberEmail: 'invited@example.com' }),
    share({ ownerId: ME, memberEmail: 'joined@example.com', memberId: THEM }),
    share({ ownerId: THEM, memberEmail: 'me@example.com', memberId: ME }),
    share({ ownerId: 'google-oauth2|other', memberEmail: 'me@example.com' }),
  ]

  it('finds the people invited to this account’s own shelf', () => {
    expect(sharesIssuedBy(rows, ME).map((row) => row.memberEmail)).toEqual([
      'invited@example.com',
      'joined@example.com',
    ])
  })

  it('finds the shelves this account has joined', () => {
    expect(shelvesJoinedBy(rows, ME).map((row) => row.ownerId)).toEqual([THEM])
  })

  it('does not count an unclaimed invitation as a shelf', () => {
    // It names an address rather than a subject, so nothing can open it yet.
    expect(shelvesJoinedBy(rows, ME)).toHaveLength(1)
    expect(invitationsAwaiting(rows, ME).map((row) => row.ownerId)).toEqual(['google-oauth2|other'])
  })

  it('does not count this account’s own invitations as ones awaiting it', () => {
    expect(invitationsAwaiting(rows, ME).every((row) => row.ownerId !== ME)).toBe(true)
  })
})
