import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listVoices, siteProvidesKey } from './elevenlabs'

vi.mock('./auth0/client', () => ({ auth0Token: () => Promise.resolve('session-token') }))

/**
 * The arrangement every provider call in this app is made under: the browser
 * holds no key, and says who is asking instead. Asserted here rather than in
 * `dubbing.ts`'s own tests because it is a property of the one function both
 * files reach the network through.
 */

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('who pays', () => {
  it('sends the session and no key at all', async () => {
    // The browser has no ElevenLabs credential to send. What it has is proof of
    // who is asking, which is what the proxy checks before attaching the site's.
    fetchMock.mockResolvedValue(json({ voices: [] }))

    await listVoices()

    const headers = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers)
    expect(headers.has('xi-api-key')).toBe(false)
    expect(headers.get('authorization')).toBe('Bearer session-token')
  })

  it('reads the deployment’s answer once and remembers it', async () => {
    fetchMock.mockResolvedValue(json({ configured: true }))

    expect(await siteProvidesKey()).toBe(true)
    expect(await siteProvidesKey()).toBe(true)
    // A property of the build on the other end, not of the moment.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/elevenlabs/status')
  })

  it('says no rather than throwing where there are no functions at all', async () => {
    // Plain `vite dev` serves no /api routes, so this rejects rather than 404s.
    vi.resetModules()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const fresh = await import('./elevenlabs')
    expect(await fresh.siteProvidesKey()).toBe(false)
  })
})
