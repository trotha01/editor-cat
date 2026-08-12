/**
 * Who this deployment is for.
 *
 * Signing in used to be a question with one answer: anyone with a Google
 * account, because all it bought them was their own workspace and their own
 * Drive. Every provider call is now on the operator's accounts — fal for
 * pictures, ElevenLabs for voices — so "signed in" and "allowed to spend" have
 * come apart, and this is the difference.
 *
 * `ALLOWED_EMAILS` is the whole configuration: a comma- or newline-separated
 * list of addresses, and `@example.com` for a whole domain. Matching is
 * case-insensitive because addresses are, and surrounding whitespace is
 * forgiven because a list pasted into a dashboard field always has some.
 *
 * **Unset means nobody**, which is the one decision here worth defending. The
 * alternative is a variable that has to be remembered or the site is open, and
 * a forgotten variable then reads as "working fine" right up until the bill —
 * exactly the failure this exists to prevent. Refusing everybody is loud,
 * immediate, and fixed in one place by the person who deployed it, who is also
 * the only person who can. The message says so and names the variable.
 *
 * Auth0 should be told the same thing — a Login Action denying unlisted
 * addresses stops the sign-in itself, which is a far better experience than
 * being let in and then refused by every button. This is the half that cannot
 * be skipped or misconfigured from a dashboard, not a replacement for it.
 */

/** How an address, or a domain, is written in the list. */
function entries(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/** Whether this deployment has been told who it is for at all. */
export function hasAllowlist(): boolean {
  return entries().length > 0
}

/**
 * Whether an address is on the list.
 *
 * Pure but for the environment read, and the awkward cases are the point: a
 * token with no address in it cannot be checked, so it cannot be allowed —
 * that is a tenant missing the email claim, not a person to let through on
 * trust. An entry of `@` alone would match every address that exists, and is
 * treated as the mistake it is rather than as a wildcard somebody meant.
 */
export function isAllowedEmail(email: string | null, list = entries()): boolean {
  if (list.length === 0) return false

  const address = (email ?? '').trim().toLowerCase()
  if (!address || !address.includes('@')) return false
  const domain = address.slice(address.lastIndexOf('@'))

  return list.some((entry) =>
    entry.startsWith('@') ? entry.length > 1 && entry === domain : entry === address,
  )
}

/** What to tell somebody the list does not have, and why it is not their fault. */
export function refusalDetail(email: string | null): string {
  if (!hasAllowlist()) {
    return 'This site has no authorised accounts configured. Whoever deployed it needs to set ALLOWED_EMAILS.'
  }
  if (!email) {
    return (
      'Your session carries no email address, so it cannot be checked against the list of ' +
      'authorised accounts. The Auth0 tenant needs the Action that adds the email claim.'
    )
  }
  return `${email} is not on this site's list of authorised accounts.`
}
