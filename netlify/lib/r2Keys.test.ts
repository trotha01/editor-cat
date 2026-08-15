import { describe, expect, it } from 'vitest'
import {
  ASSET_CONTENT_TYPES,
  MAX_OBJECTS_PER_REQUEST,
  assetPrefix,
  assetPrefixesFor,
  hashSubject,
  isAllowedContentType,
  isSafeId,
  isSafeName,
  isUnderAnyPrefix,
  isUnderPrefix,
  keysUnder,
  publicationPrefix,
  publicationPrefixFor,
} from './r2Keys'

describe('isSafeName', () => {
  it('accepts the names we actually write', () => {
    expect(isSafeName('index.m3u8')).toBe(true)
    expect(isSafeName('init.mp4')).toBe(true)
    expect(isSafeName('seg00001.m4s')).toBe(true)
    expect(isSafeName('poster.jpg')).toBe(true)
    expect(isSafeName('asset_01H9-abc')).toBe(true)
  })

  it('refuses anything that could become a path', () => {
    expect(isSafeName('a/b')).toBe(false)
    expect(isSafeName('..')).toBe(false)
    expect(isSafeName('../secret')).toBe(false)
    expect(isSafeName('%2e%2e')).toBe(false)
    expect(isSafeName('a\\b')).toBe(false)
    expect(isSafeName('')).toBe(false)
  })

  it('refuses names that are merely strange', () => {
    expect(isSafeName('has space.mp4')).toBe(false)
    expect(isSafeName('emoji🙂.mp4')).toBe(false)
    expect(isSafeName('a'.repeat(65))).toBe(false)
    expect(isSafeName('a'.repeat(64))).toBe(true)
  })

  it('refuses a leading dot, which is what makes ".." reachable', () => {
    // R2 would store a key literally named ".." quite happily — keys are opaque
    // strings. The damage is downstream: an HLS playlist names its segments by
    // relative URI, so a browser resolving ".." against the playlist walks up
    // out of the prefix.
    expect(isSafeName('.')).toBe(false)
    expect(isSafeName('.hidden')).toBe(false)
  })
})

describe('isSafeId', () => {
  it('accepts a uuid and the ids newId() mints', () => {
    expect(isSafeId('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe(true)
    expect(isSafeId('export_0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe(true)
  })

  it('refuses dots, so an id can never be a traversal', () => {
    // Stricter than isSafeName deliberately: an id becomes a whole path
    // segment, and there is no id we mint that needs a dot.
    expect(isSafeId('..')).toBe(false)
    expect(isSafeId('a.b')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId('')).toBe(false)
  })
})

describe('hashSubject', () => {
  it('does not leak the subject', async () => {
    const hash = await hashSubject('google-oauth2|104372000000000000000')
    expect(hash).not.toContain('google')
    expect(hash).not.toContain('104372')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable, so a second device finds the same prefix', async () => {
    const once = await hashSubject('auth0|abc')
    const twice = await hashSubject('auth0|abc')
    expect(once).toBe(twice)
  })

  it('separates two accounts', async () => {
    expect(await hashSubject('auth0|abc')).not.toBe(await hashSubject('auth0|abd'))
  })
})

describe('publicationPrefixFor', () => {
  it('builds the prefix from the Mintspace uid, not the Auth0 subject', () => {
    const result = publicationPrefixFor('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'export_abc')
    expect(result).toEqual({
      ok: true,
      prefix: 'v1/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/export_abc/',
    })
  })

  it('refuses a traversal in either id', () => {
    expect(publicationPrefixFor('..', 'export_abc').ok).toBe(false)
    expect(publicationPrefixFor('uid', '..').ok).toBe(false)
    expect(publicationPrefixFor('a/b', 'export_abc').ok).toBe(false)
    expect(publicationPrefixFor('uid', 'a/b').ok).toBe(false)
  })

  it('refuses an empty id, which would collapse the namespace', () => {
    // The dangerous one: an empty segment turns "this publication" into
    // "everything this account ever published".
    expect(publicationPrefixFor('uid', '').ok).toBe(false)
    expect(publicationPrefixFor('', 'export_abc').ok).toBe(false)
  })
})

describe('keysUnder', () => {
  const prefix = publicationPrefix('uid', 'pub')

  it('joins bare names onto the derived prefix', () => {
    const result = keysUnder(prefix, ['index.m3u8', 'init.mp4', 'seg00001.m4s'])
    expect(result).toEqual({
      ok: true,
      keys: ['v1/uid/pub/index.m3u8', 'v1/uid/pub/init.mp4', 'v1/uid/pub/seg00001.m4s'],
    })
  })

  it('refuses a name that would climb out of the prefix', () => {
    expect(keysUnder(prefix, ['../../other/index.m3u8']).ok).toBe(false)
    expect(keysUnder(prefix, ['nested/seg.m4s']).ok).toBe(false)
  })

  it('refuses an empty request and one over the cap', () => {
    expect(keysUnder(prefix, []).ok).toBe(false)
    const tooMany = Array.from({ length: MAX_OBJECTS_PER_REQUEST + 1 }, (_, i) => `seg${i}.m4s`)
    expect(keysUnder(prefix, tooMany).ok).toBe(false)
  })

  it('refuses a duplicate, which would sign two URLs for one object', () => {
    expect(keysUnder(prefix, ['init.mp4', 'init.mp4']).ok).toBe(false)
  })
})

describe('isUnderPrefix', () => {
  it('accepts a key the upload path would have produced', () => {
    expect(isUnderPrefix('v1/uid/pub/seg00001.m4s', 'v1/uid/pub/')).toBe(true)
  })

  it('refuses another account, even one whose prefix starts the same', () => {
    expect(isUnderPrefix('v1/other/pub/seg.m4s', 'v1/uid/pub/')).toBe(false)
    // The near-miss worth naming: a prefix that is a string prefix of another.
    expect(isUnderPrefix('v1/uid/pub2/seg.m4s', 'v1/uid/pub/')).toBe(false)
  })

  it('refuses deeper nesting and traversal below the prefix', () => {
    expect(isUnderPrefix('v1/uid/pub/nested/seg.m4s', 'v1/uid/pub/')).toBe(false)
    expect(isUnderPrefix('v1/uid/pub/../../x', 'v1/uid/pub/')).toBe(false)
  })
})

describe('content types', () => {
  it('allows what a publication is made of', () => {
    expect(isAllowedContentType('publication', 'application/vnd.apple.mpegurl')).toBe(true)
    expect(isAllowedContentType('publication', 'video/iso.segment')).toBe(true)
    expect(isAllowedContentType('publication', 'image/jpeg')).toBe(true)
  })

  it('refuses anything that would make the CDN domain host a page', () => {
    expect(isAllowedContentType('publication', 'text/html')).toBe(false)
    expect(isAllowedContentType('publication', 'image/svg+xml')).toBe(false)
    expect(isAllowedContentType('asset', 'text/html')).toBe(false)
  })

  it('allows the media the editor actually ingests', () => {
    for (const type of ASSET_CONTENT_TYPES) {
      expect(isAllowedContentType('asset', type)).toBe(true)
    }
  })
})

describe('assetPrefix', () => {
  it('namespaces by the hashed subject', async () => {
    const hash = await hashSubject('auth0|abc')
    expect(assetPrefix(hash)).toBe(`asset/${hash}/`)
  })
})

/**
 * The plural form, for a caller who is on somebody else's word shelf.
 *
 * The set is still derived from subjects rather than sent by the client — see
 * shelfShares.ts — so what is worth pinning here is only that widening the
 * question to several prefixes did not loosen it for any one of them.
 */
describe('several prefixes at once', () => {
  it('accepts a key under any of them', async () => {
    const mine = assetPrefix(await hashSubject('auth0|me'))
    const theirs = assetPrefix(await hashSubject('auth0|them'))

    expect(isUnderAnyPrefix(`${theirs}asset_1`, [mine, theirs])).toBe(true)
    expect(isUnderAnyPrefix(`${mine}asset_1`, [mine, theirs])).toBe(true)
  })

  it('refuses a key under none of them', async () => {
    const mine = assetPrefix(await hashSubject('auth0|me'))
    expect(isUnderAnyPrefix('asset/00000000000000000000000000000000/x', [mine])).toBe(false)
  })

  it('refuses everything when the set is empty', () => {
    expect(isUnderAnyPrefix('asset/whatever/x', [])).toBe(false)
  })

  it('still refuses traversal, whichever prefix it starts from', async () => {
    const mine = assetPrefix(await hashSubject('auth0|me'))
    const theirs = assetPrefix(await hashSubject('auth0|them'))
    expect(isUnderAnyPrefix(`${theirs}../../etc`, [mine, theirs])).toBe(false)
  })

  it('derives one prefix per subject, in order', async () => {
    expect(await assetPrefixesFor(['auth0|me', 'auth0|them'])).toEqual([
      assetPrefix(await hashSubject('auth0|me')),
      assetPrefix(await hashSubject('auth0|them')),
    ])
  })
})
