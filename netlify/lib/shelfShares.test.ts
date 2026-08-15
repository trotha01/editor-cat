import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { counterpartsIn, shelfCounterparts, supabaseConfig, resetForTests } from './shelfShares'

/**
 * Working out whose storage a caller may reach besides their own.
 *
 * The interesting cases here are all refusals, and one of them is the reason the
 * module exists in the shape it does: an access token this site verified, paired
 * with an ID token belonging to somebody else, must not be able to ask the
 * database a question about that somebody else. PostgREST would answer it
 * perfectly happily — the token is genuine — so the check has to be here.
 *
 * The other thing worth pinning is that "could not ask" and "the answer is
 * nobody" stay apart all the way out of this module. They lead to a 502 and a
 * 403 respectively, and merging them is how a failed lookup starts telling
 * people their collaborator's takes are not theirs.
 */

/** A token whose payload decodes to `{ sub }`. Signature is never read here. */
function idTokenFor(sub: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '')
  return `${encode({ alg: 'RS256' })}.${encode({ sub })}.signature`
}

const ME = 'google-oauth2|104372000000000000000'
const THEM = 'google-oauth2|555555555555555555555'

const fetchMock = vi.fn()

beforeEach(() => {
  resetForTests()
  vi.stubGlobal('fetch', fetchMock)
  process.env.SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_ANON_KEY = 'anon-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_ANON_KEY
  delete process.env.VITE_SUPABASE_URL
  delete process.env.VITE_SUPABASE_ANON_KEY
})

function answers(rows: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } }),
  )
}

describe('reading the other party out of a share row', () => {
  it('takes the member when the caller owns the shelf', () => {
    expect(counterpartsIn([{ owner_id: ME, member_id: THEM }], ME)).toEqual([THEM])
  })

  it('takes the owner when the caller is the member', () => {
    expect(counterpartsIn([{ owner_id: THEM, member_id: ME }], ME)).toEqual([THEM])
  })

  it('skips an invitation nobody has claimed', () => {
    // No subject on the row, so there is no prefix to derive from it — the
    // address it names is not something storage keys are made of.
    expect(counterpartsIn([{ owner_id: ME, member_id: null }], ME)).toEqual([])
  })

  it('drops a row naming neither side of the caller', () => {
    // Unreachable through the policies, so this is defence against a query that
    // has gone wrong rather than against a user — but this is the one function
    // that turns a response body into permission to read files.
    expect(counterpartsIn([{ owner_id: 'a', member_id: 'b' }], ME)).toEqual([])
  })

  it('never returns the caller themselves', () => {
    expect(counterpartsIn([{ owner_id: ME, member_id: ME }], ME)).toEqual([])
  })

  it('says nobody when the body is not a list at all', () => {
    expect(counterpartsIn({ message: 'no' }, ME)).toEqual([])
    expect(counterpartsIn(null, ME)).toEqual([])
  })

  it('counts a person shared with twice only once', () => {
    expect(
      counterpartsIn(
        [
          { owner_id: ME, member_id: THEM },
          { owner_id: THEM, member_id: ME },
        ],
        ME,
      ),
    ).toEqual([THEM])
  })
})

describe('asking the database', () => {
  it('returns the subjects a share pairs the caller with', async () => {
    answers([{ owner_id: THEM, member_id: ME }])

    const result = await shelfCounterparts(ME, idTokenFor(ME))

    expect(result).toEqual({ subjects: [THEM], degraded: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the caller’s own token, so row-level security answers for them', async () => {
    answers([])
    const token = idTokenFor(ME)

    await shelfCounterparts(ME, token)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/rest/v1/shelf_shares')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`)
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key')
  })

  it('refuses an ID token belonging to somebody else, without asking', async () => {
    // The whole reason this module reads an unverified claim. The token is
    // perfectly genuine — it is simply not this caller's, and PostgREST would
    // answer for whoever it names.
    const result = await shelfCounterparts(ME, idTokenFor(THEM))

    expect(result.degraded).toBe(true)
    expect(result.subjects).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is degraded rather than empty when no account token was sent', async () => {
    const result = await shelfCounterparts(ME, null)
    expect(result).toMatchObject({ subjects: [], degraded: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is degraded when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('econnreset'))
    const result = await shelfCounterparts(ME, idTokenFor(ME))
    expect(result.degraded).toBe(true)
    expect(result.reason).toContain('econnreset')
  })

  it('is degraded when the database refuses', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))
    const result = await shelfCounterparts(ME, idTokenFor(ME))
    expect(result).toMatchObject({ degraded: true })
    expect(result.reason).toContain('401')
  })

  it('answers nobody, and does not fail, on a site with no Supabase', async () => {
    // Sign-in itself needs one, so a deployment without it has no accounts and
    // no shares. An empty answer is the true answer, not a lookup that broke —
    // and a 502 here would never resolve.
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY

    expect(await shelfCounterparts(ME, idTokenFor(ME))).toEqual({ subjects: [], degraded: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks once for a burst of batches', async () => {
    // Opening a shared word signs its takes in batches of sixty-four; without
    // the cache each batch is a round trip for an answer that cannot have moved.
    answers([{ owner_id: THEM, member_id: ME }])

    await shelfCounterparts(ME, idTokenFor(ME))
    await shelfCounterparts(ME, idTokenFor(ME))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not let one caller’s answer be handed to another', async () => {
    answers([{ owner_id: THEM, member_id: ME }])
    await shelfCounterparts(ME, idTokenFor(ME))

    answers([])
    const other = await shelfCounterparts(THEM, idTokenFor(THEM))

    expect(other.subjects).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('finding the project', () => {
  it('accepts the VITE_ forms, which are the same two public values', () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
    process.env.VITE_SUPABASE_URL = 'https://project.supabase.co/'
    process.env.VITE_SUPABASE_ANON_KEY = 'anon-key'

    expect(supabaseConfig()).toEqual({ url: 'https://project.supabase.co', anonKey: 'anon-key' })
  })

  it('is null when either half is missing', () => {
    delete process.env.SUPABASE_ANON_KEY
    expect(supabaseConfig()).toBeNull()
  })
})
