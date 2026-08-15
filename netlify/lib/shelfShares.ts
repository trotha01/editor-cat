/**
 * Whose storage a caller may reach besides their own.
 *
 * R2 has no row-level security, so `r2Keys.ts` derives every prefix from a
 * verified subject and the endpoint accepts none from the client. That is still
 * the model. Sharing a word shelf adds exactly one thing to it: a *set* of
 * subjects rather than one, and this module is where the set comes from.
 *
 * **The database is the authority, not this process.** A share is a row in
 * `shelf_shares` with policies over it (supabase/migrations/0012_shelf_shares.sql),
 * and re-implementing those policies here in TypeScript would be two answers to
 * one question, drifting apart, with the looser one winning. So this asks
 * PostgREST and believes what it says.
 *
 *
 * WHY TWO TOKENS
 *
 * PostgREST has to be asked *as the caller*, or the answer is either everyone's
 * rows or nobody's. The token it accepts is the Auth0 ID token — the only one
 * carrying the `role` claim it switches on, which is why the browser already
 * sends that one to Supabase and this site's own access token to everything
 * here. So the browser sends both, in two headers, the same way publishing sends
 * an Auth0 session and a Mintspace one.
 *
 * The alternative was a Supabase service-role key in this environment. That is a
 * credential which reads and writes every row of every table with row-level
 * security switched off, held by a function whose whole job is handing out URLs
 * — for a lookup the caller is perfectly entitled to make themselves. Both
 * values this module reads instead (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) are
 * already public: they ship in the browser bundle.
 *
 *
 * WHY THE SUBJECT IS CHECKED TWICE
 *
 * The ID token arrives unverified on this side and stays that way — its audience
 * is the SPA client, not this site's API, so `auth0User` would rightly refuse
 * it. Verification happens at PostgREST. What is left to go wrong is somebody
 * pairing *their own* valid access token with *somebody else's* valid ID token,
 * which would ask the database a question about a person they are not, and get
 * back a set of prefixes to read.
 *
 * So the subject the ID token claims must equal the subject the access token
 * proved. Reading an unverified claim is sound here and only here: a forged
 * token fails at PostgREST and yields nothing, and a genuine token belonging to
 * someone else fails this comparison and is never sent. The two checks are
 * complementary, and neither is load-bearing alone.
 */
import { unverifiedSubject } from './auth0'

export interface SupabaseConfig {
  /** Project URL, no trailing slash. */
  url: string
  /** The anon key. Public by design — row-level security is the protection. */
  anonKey: string
}

/**
 * How this deployment reaches Supabase, or null when it has none.
 *
 * `VITE_` fallbacks for the same reason auth0.ts has them: these are the two
 * values the browser is already built with, and asking an operator to set one
 * string twice is how the two drift apart.
 */
export function supabaseConfig(): SupabaseConfig | null {
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  const anonKey = (process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/**
 * The result of asking, kept apart from "the answer is nobody".
 *
 * `degraded` means the question could not be put — no second token was sent, it
 * named somebody else, or the request failed. The caller must not read that as
 * an empty set, because the two lead to opposite responses: an empty set is a
 * 403 that will still be a 403 tomorrow, and a degraded lookup is a 502 that
 * will not be.
 *
 * A deployment with no Supabase at all is *not* degraded, and the distinction is
 * deliberate. Sign-in itself is gated on having one (`requiresSignIn`), so a
 * site without one has no accounts, no share rows and nobody to share with: the
 * empty answer is the true answer rather than a lookup that failed, and a 502
 * there would turn "that key is not yours" into an outage that never resolves.
 */
export interface Counterparts {
  subjects: string[]
  degraded: boolean
  reason?: string
}

interface ShareRow {
  owner_id: string
  member_id: string | null
}

/**
 * Long enough that hydrating a shelf is one lookup, short enough that a
 * revocation is not a thing you have to wait out.
 *
 * Opening a word somebody shared signs its takes in batches of sixty-four, and
 * a whole shelf can be several of those in a row; without a cache each is a
 * round trip to PostgREST for an answer that cannot have changed. Thirty seconds
 * bounds the other direction: a share taken away stops working within it, and
 * the objects are behind presigned URLs whose own lifetime is the same order of
 * magnitude, so a tighter cache here would not shorten the real window anyway.
 */
const CACHE_TTL_MS = 30_000

interface CacheEntry {
  subjects: string[]
  at: number
}

const cache = new Map<string, CacheEntry>()

/**
 * The subjects this caller shares a shelf with, in either direction.
 *
 * `idToken` is what the browser sent in `x-supabase-authorization`, or null when
 * it sent nothing — an older client, or any caller that never needed the header.
 * Null is not an error: it produces a degraded answer, and downloads of the
 * caller's own files never consult this at all.
 */
export async function shelfCounterparts(
  subject: string,
  idToken: string | null,
): Promise<Counterparts> {
  const config = supabaseConfig()
  // Nothing to ask and nobody to ask about — see `Counterparts`.
  if (!config) return { subjects: [], degraded: false }

  if (!idToken) {
    return { subjects: [], degraded: true, reason: 'No account token was sent with that request.' }
  }

  // See the header: this proves nothing on its own, and is paired with
  // PostgREST's own verification of the same token.
  if (unverifiedSubject(idToken) !== subject) {
    return {
      subjects: [],
      degraded: true,
      reason: 'That account token is for a different account.',
    }
  }

  const cached = cache.get(subject)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { subjects: cached.subjects, degraded: false }
  }

  let response: Response
  try {
    response = await fetch(`${config.url}/rest/v1/shelf_shares?select=owner_id,member_id`, {
      headers: {
        apikey: config.anonKey,
        authorization: `Bearer ${idToken}`,
        accept: 'application/json',
      },
    })
  } catch (cause) {
    return {
      subjects: [],
      degraded: true,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }

  if (!response.ok) {
    return { subjects: [], degraded: true, reason: `Supabase answered ${response.status}.` }
  }

  let rows: unknown
  try {
    rows = await response.json()
  } catch {
    return { subjects: [], degraded: true, reason: 'Supabase did not answer with JSON.' }
  }

  const subjects = counterpartsIn(rows, subject)
  cache.set(subject, { subjects, at: Date.now() })
  return { subjects, degraded: false }
}

/**
 * The other party of every claimed share in a result set.
 *
 * Unclaimed rows — an invitation nobody has signed in against yet — are skipped:
 * they name an address rather than a subject, and there is no prefix to derive
 * from one. Rows naming neither side of the caller cannot come back through the
 * policies, and are dropped rather than trusted, because this is the one place
 * that turns a response body into permission to read somebody's files.
 */
export function counterpartsIn(rows: unknown, subject: string): string[] {
  if (!Array.isArray(rows)) return []

  const found = new Set<string>()
  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<ShareRow>
    const owner = typeof row.owner_id === 'string' ? row.owner_id : null
    const member = typeof row.member_id === 'string' ? row.member_id : null
    if (!owner || !member) continue

    if (owner === subject) found.add(member)
    else if (member === subject) found.add(owner)
  }

  // Yourself is never a counterpart: the caller's own prefix is derived
  // directly, and letting it arrive by this route as well would mean a bug in
  // the query could look like it was working.
  found.delete(subject)
  return [...found]
}

/** Test seam: forget who shares with whom. */
export function resetForTests(): void {
  cache.clear()
}
