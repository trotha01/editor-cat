import { describe, expect, it } from 'vitest'
import { escapeQueryValue, kindForMime, parentClauses } from './drive'

describe('escapeQueryValue', () => {
  it('leaves ordinary ids untouched', () => {
    expect(escapeQueryValue('1a2B3c_-xyz')).toBe('1a2B3c_-xyz')
  })

  it('escapes the single quote that would close a query term early', () => {
    // A folder called "Trevor's clips" is otherwise a 400 from Drive.
    expect(escapeQueryValue("Trevor's clips")).toBe("Trevor\\'s clips")
  })

  it('escapes backslashes before quotes so the escape cannot be escaped away', () => {
    expect(escapeQueryValue('back\\slash')).toBe('back\\\\slash')
    expect(escapeQueryValue("a\\'b")).toBe("a\\\\\\'b")
  })
})

describe('kindForMime', () => {
  it('maps the media types the editor can use', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/webm;codecs=opus')).toBe('audio')
  })

  it('rejects anything else, so Docs and folders never reach the library', () => {
    expect(kindForMime('application/vnd.google-apps.document')).toBeNull()
    expect(kindForMime('application/vnd.google-apps.folder')).toBeNull()
    expect(kindForMime('application/pdf')).toBeNull()
  })
})

describe('parentClauses', () => {
  it('builds a single OR group for a small folder set', () => {
    expect(parentClauses(['a', 'b'])).toEqual([`('a' in parents or 'b' in parents)`])
  })

  it('splits large sets so no one query outgrows Drive’s length limit', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `f${index}`)
    const clauses = parentClauses(ids, 25)

    expect(clauses).toHaveLength(3)
    // Every id must appear exactly once across the batches, or media silently
    // goes missing from the import list.
    const mentioned = ids.filter((id) => clauses.some((clause) => clause.includes(`'${id}'`)))
    expect(mentioned).toHaveLength(60)
  })

  it('escapes ids inside the clause', () => {
    expect(parentClauses(["it's"])).toEqual([`('it\\'s' in parents)`])
  })

  it('returns nothing for an empty folder list', () => {
    expect(parentClauses([])).toEqual([])
  })
})
