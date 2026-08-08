import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { captionFonts as CaptionFonts } from './captionFonts'

const originalFetch = globalThis.fetch

/**
 * A fresh module per test, because the cache it keeps is the thing under test:
 * a shared one would let an earlier case answer a later one's fetch.
 */
let captionFonts: typeof CaptionFonts

beforeEach(async () => {
  vi.resetModules()
  captionFonts = (await import('./captionFonts')).captionFonts
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serveFont(bytes = 64) {
  const fetchMock = vi.fn(
    async () => new Response(new Uint8Array(bytes).fill(7)) as unknown as Response,
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('captionFonts', () => {
  it('fetches the one shipped face', async () => {
    const fetchMock = serveFont()
    const fonts = await captionFonts()
    expect(fonts.map((font) => font.fileName)).toEqual(['LindyToonWide-Regular.ttf'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hands out a fresh copy each time, because writing to ffmpeg detaches it', async () => {
    // `ffmpeg.writeFile` transfers the Uint8Array's buffer into the worker. A
    // cache that handed back the same array would give the second export of a
    // session a zero-length font — and libass with an unreadable font draws
    // nothing while still exiting successfully.
    const fetchMock = serveFont()
    const [first] = await captionFonts()
    structuredClone(first!.bytes.buffer, { transfer: [first!.bytes.buffer] })
    expect(first!.bytes.byteLength).toBe(0)

    const [second] = await captionFonts()
    expect(second!.bytes.byteLength).toBe(64)
    // Still cached: a second export must not fetch the font again either.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails loudly when the font is not there to be served', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(captionFonts()).rejects.toThrow(/caption font could not be loaded/)
  })
})
