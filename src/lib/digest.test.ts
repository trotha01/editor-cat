import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from './digest'

/**
 * The hash that tells one export from the same export again.
 *
 * Two properties matter and they pull in opposite directions. The same bytes
 * must hash the same and different bytes must not, or the duplicate check is
 * worthless. And a browser that cannot hash at all must say so quietly rather
 * than throw, because the caller's fallback is to publish anyway — refusing to
 * post over a comparison that could not be made would be the worse failure.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sha256Hex', () => {
  it('is the published SHA-256 of the bytes, in lowercase hex', async () => {
    // The canonical digest of "abc", which is worth pinning against a known
    // value rather than against this implementation's own output.
    await expect(sha256Hex(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is the same for the same bytes, whatever blob carries them', async () => {
    const one = await sha256Hex(new Blob(['some mp4 bytes']))
    const two = await sha256Hex(new Blob([new Blob(['some mp4 bytes'])]))

    expect(one).toBe(two)
  })

  it('differs for a file that differs by one byte', async () => {
    const one = await sha256Hex(new Blob(['some mp4 bytes']))
    const two = await sha256Hex(new Blob(['some mp4 byteS']))

    expect(one).not.toBe(two)
  })

  it('is null where there is no SubtleCrypto, rather than a throw', async () => {
    // What a page served over plain http gets.
    vi.stubGlobal('crypto', {})

    await expect(sha256Hex(new Blob(['abc']))).resolves.toBeNull()
  })

  it('is null when hashing itself refuses', async () => {
    vi.stubGlobal('crypto', {
      subtle: { digest: () => Promise.reject(new Error('nope')) },
    })

    await expect(sha256Hex(new Blob(['abc']))).resolves.toBeNull()
  })
})
