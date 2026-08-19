import { describe, expect, it, vi } from 'vitest'
import { getAssets } from './assets'

const inCalls: string[][] = []

vi.mock('./client', () => ({
  supabase: () => ({
    from: () => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          inCalls.push(ids)
          return Promise.resolve({ data: ids.map((id) => ({ id })), error: null })
        },
      }),
    }),
  }),
}))

describe('getAssets', () => {
  it('asks for nothing without a round trip', async () => {
    expect(await getAssets([])).toEqual([])
    expect(inCalls).toEqual([])
  })

  it('asks in one request for a handful of ids', async () => {
    inCalls.length = 0
    const ids = Array.from({ length: 10 }, (_, i) => `asset_${i}`)
    const rows = await getAssets(ids)
    expect(inCalls).toEqual([ids])
    expect(rows.map((row) => row.id)).toEqual(ids)
  })

  /**
   * A word shelf asks for every take of every word on the account in one call
   * (see `hydrateShelfAssets`), which can run into the hundreds. `in.(...)` puts
   * every id in the query string, so left whole it grows without a ceiling —
   * split, no single request is a size nobody involved has seen before.
   */
  it('splits a long list into batches rather than one request naming them all', async () => {
    inCalls.length = 0
    const ids = Array.from({ length: 230 }, (_, i) => `asset_${i}`)
    const rows = await getAssets(ids)
    expect(inCalls.map((batch) => batch.length)).toEqual([100, 100, 30])
    expect(rows.map((row) => row.id)).toEqual(ids)
  })
})
