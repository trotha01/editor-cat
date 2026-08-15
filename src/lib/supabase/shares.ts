/**
 * Who else is on a word shelf.
 *
 * One row per invitation in `shelf_shares` — see
 * supabase/migrations/0012_shelf_shares.sql, which is where the actual rules
 * live. Everything here is a thin call over policies that have already decided
 * what may be read and written; nothing in this file is a permission check, and
 * nothing in it should become one.
 *
 * **An invitation names an address; a share names a subject.** The owner types
 * `someone@example.com`, because that is what they know. Every policy in this
 * schema matches on an Auth0 subject, and there is nothing in this deployment
 * that turns one into the other — so the row is written with an address and a
 * null subject, and the person it names fills the subject in themselves the
 * first time they open the page (`claimInvitations`). Until they do, the owner's
 * sharing list shows them as invited rather than joined, which is the honest
 * description of a row that no policy can match yet.
 *
 * One query reads the lot. Row-level security already answers "rows I own, rows
 * I am the member of, and invitations waiting for my address" in a single
 * select, so partitioning that by hand here is cheaper than three round trips
 * and cannot disagree with itself halfway through.
 */
import { supabase } from './client'
import { currentAccount } from '../auth0/client'

export interface ShelfShare {
  /** The Auth0 subject whose shelf this is. */
  ownerId: string
  /** The address the owner invited, always lowercase. */
  memberEmail: string
  /** The member's Auth0 subject, or null while the invitation is unclaimed. */
  memberId: string | null
  createdAt: string
  claimedAt: string | null
}

interface ShareRow {
  owner_id: string
  member_email: string
  member_id: string | null
  created_at: string
  claimed_at: string | null
}

function fromRow(row: ShareRow): ShelfShare {
  return {
    ownerId: row.owner_id,
    memberEmail: row.member_email,
    memberId: row.member_id,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
  }
}

/**
 * The address as it will be stored and matched.
 *
 * Lowercased because the column has a check constraint saying so and the claim
 * matches on it, so `Someone@Example.com` written as typed is an invitation
 * nobody can ever accept. Trimmed because a pasted address usually arrives with
 * something on the end of it.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Whether this is worth sending to the database at all.
 *
 * Deliberately loose. The real check on an address is whether somebody signs in
 * with it, and a stricter pattern here would only reject valid addresses that
 * look unusual — what this is for is catching a name or an empty box before it
 * becomes a row that can never be claimed.
 */
export function looksLikeEmail(email: string): boolean {
  const value = normaliseEmail(email)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/** Every share row this account can see, whichever side of it they are on. */
export async function listShares(): Promise<ShelfShare[]> {
  const { data, error } = await supabase()
    .from('shelf_shares')
    .select('owner_id,member_email,member_id,created_at,claimed_at')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return ((data ?? []) as ShareRow[]).map(fromRow)
}

/** The ones for a shelf of the caller's own — the people they have invited. */
export function sharesIssuedBy(shares: readonly ShelfShare[], subject: string): ShelfShare[] {
  return shares.filter((share) => share.ownerId === subject)
}

/**
 * The shelves belonging to other people that this account has joined.
 *
 * Claimed rows only. An invitation that has not been claimed names an address
 * rather than this account, so it is not yet a shelf anything can open — see
 * `claimInvitations`, which is what turns one into the other.
 */
export function shelvesJoinedBy(shares: readonly ShelfShare[], subject: string): ShelfShare[] {
  return shares.filter((share) => share.ownerId !== subject && share.memberId === subject)
}

/** Invitations waiting for this account's address that it has not claimed. */
export function invitationsAwaiting(shares: readonly ShelfShare[], subject: string): ShelfShare[] {
  return shares.filter((share) => share.ownerId !== subject && share.memberId === null)
}

/**
 * Invites an address onto the caller's own shelf.
 *
 * `owner_id` is not sent: it defaults from the JWT, so there is no version of
 * this call that could write a row on somebody else's behalf. Upserted rather
 * than inserted because inviting the same address twice is a thing people do,
 * and it should not be an error the second time — but `ignoreDuplicates` keeps
 * an existing row's `member_id` rather than blanking a share that has already
 * been claimed.
 */
export async function inviteMember(email: string): Promise<void> {
  const address = normaliseEmail(email)
  if (!looksLikeEmail(address)) throw new Error(`"${email.trim()}" is not an email address.`)

  const { error } = await supabase()
    .from('shelf_shares')
    .upsert(
      { member_email: address },
      { onConflict: 'owner_id,member_email', ignoreDuplicates: true },
    )

  if (error) throw new Error(error.message)
}

/**
 * Takes an address back off the caller's own shelf.
 *
 * The row is the only thing granting access, so removing it is the whole of a
 * revocation on the database side. Storage is a separate matter and is checked
 * per request rather than cached — see netlify/lib/shelfShares.ts, whose cache
 * is short for exactly this reason.
 */
export async function revokeShare(email: string): Promise<void> {
  const account = currentAccount()
  if (!account) throw new Error('Sign in to change who a shelf is shared with.')

  const { error } = await supabase()
    .from('shelf_shares')
    .delete()
    .eq('owner_id', account.id)
    .eq('member_email', normaliseEmail(email))

  if (error) throw new Error(error.message)
}

/** Gives up a shelf somebody else shared with this account. */
export async function leaveShelf(ownerId: string): Promise<void> {
  const account = currentAccount()
  if (!account) throw new Error('Sign in to leave a shelf.')

  const { error } = await supabase()
    .from('shelf_shares')
    .delete()
    .eq('owner_id', ownerId)
    .eq('member_id', account.id)

  if (error) throw new Error(error.message)
}

/**
 * Writes this account's subject onto any invitation addressed to it.
 *
 * The one write that turns an address into something the policies can match.
 * Called on every load rather than once: an invitation can be issued at any
 * time, including while the person it names has the page open, and there is
 * nothing to be gained by making them find a button for it.
 *
 * Returns how many rows moved, which is what tells the caller whether the list
 * of shelves it is about to draw has just changed.
 *
 * A no-op is the overwhelmingly common case and costs one filtered update
 * matching nothing. The filters here are belt and braces over the
 * `claim_shelf_share` policy, which is what actually decides: it re-checks the
 * address against a verified claim, so a client that sent somebody else's
 * address would match no rows.
 */
export async function claimInvitations(): Promise<number> {
  const account = currentAccount()
  if (!account?.email) return 0

  const { data, error } = await supabase()
    .from('shelf_shares')
    .update({ member_id: account.id, claimed_at: new Date().toISOString() })
    .is('member_id', null)
    .eq('member_email', normaliseEmail(account.email))
    .select('owner_id')

  if (error) throw new Error(error.message)
  return (data ?? []).length
}
