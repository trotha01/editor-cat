/**
 * Which shelf the word pages are looking at.
 *
 * There used to be one, always, and it was yours: `word_shelves` held a row per
 * account and row-level security meant a query could only ever come back with
 * that one. Sharing makes the answer a list — your own, plus one for every
 * person who has let you onto theirs — so something has to choose, remember the
 * choice, and cope with it being taken away.
 *
 * Everything here is pure so that all three can be tested without a database, a
 * browser, or a signed-in account. The store calls it; nothing in it calls the
 * store.
 */
import type { ShelfShare } from './supabase/shares'

export interface ShelfChoice {
  /** The Auth0 subject whose shelf this is. */
  ownerId: string
  /**
   * The address the owner is known by, when there is one to show.
   *
   * Only ever available for somebody *else's* shelf, and only because the share
   * row that let you onto it was written against your address and theirs is on
   * the row you can see. Your own shelf has no address here because it does not
   * need one: it is called "My shelf".
   */
  ownerEmail: string | null
  /** Whether this is the signed-in account's own shelf. */
  mine: boolean
}

/**
 * Every shelf this account can open, own first.
 *
 * Your own is always in the list and always at the top, even on an account that
 * has never written a word: a shelf that does not exist yet is one save away
 * from existing, and leaving it out would mean somebody invited to one shelf
 * had no way back to their own.
 *
 * Shares that nobody has claimed are not shelves. They name an address rather
 * than a subject, so there is no row any policy would match — see
 * `claimInvitations`, which is what turns one into the other before this is
 * asked.
 */
export function shelvesAvailable(shares: readonly ShelfShare[], subject: string): ShelfChoice[] {
  const joined = shares
    .filter((share) => share.ownerId !== subject && share.memberId === subject)
    // Stable and not arbitrary: two shelves from the same person cannot happen,
    // so the owner's subject is a total order, and it is the same order on every
    // machine — which is what stops a picker reshuffling itself between visits.
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
    .map((share) => ({ ownerId: share.ownerId, ownerEmail: null, mine: false }))

  return [{ ownerId: subject, ownerEmail: null, mine: true }, ...joined]
}

/**
 * The shelf to open, given what was remembered and what is still there.
 *
 * Falls back to your own whenever the remembered one is not on offer, which is
 * what a revoked share looks like from this side. That is a silent demotion by
 * design: the alternative is a page that refuses to draw until somebody
 * acknowledges a thing that has already happened and that they cannot undo.
 */
export function resolveActiveShelf(
  remembered: string | null,
  available: readonly ShelfChoice[],
  subject: string,
): string {
  if (remembered && available.some((shelf) => shelf.ownerId === remembered)) return remembered
  return subject
}

/**
 * A localStorage key, scoped to the shelf it is about.
 *
 * Your own shelf keeps the bare key it has always had. That is not tidiness: a
 * browser that has been syncing a shelf for months has a `syncedAt` under the
 * old name, and a suffix on it would read as "never synced" and treat every
 * local row as work the account has not been told about. Only shelves that
 * arrived with sharing get a suffix, because only they have no history to keep.
 *
 * `null` — signed out, or no Supabase behind this deployment — is also the bare
 * key, and correctly: that is the same shelf the account will call its own the
 * moment somebody signs in.
 */
export function shelfScopedKey(
  base: string,
  ownerId: string | null,
  subject: string | null,
): string {
  if (!ownerId || ownerId === subject) return base
  return `${base}.shelf:${ownerId}`
}
