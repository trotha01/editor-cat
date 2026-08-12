import { describe, expect, it } from 'vitest'
import { publicationsOf, publishedAs } from './publications'
import type { Project, Publication } from '../types'

/**
 * Whether this project's export is already in the Mintspace feed.
 *
 * The question is asked of the *file*, not of the project, and the difference
 * is the whole design: a project is a thing that changes, and re-exporting
 * after an edit is a new video that should go up as one. What must not happen
 * is the identical file going up twice — so the match is on content, and the
 * awkward case is a browser that would not hash at all, which must leave
 * publishing possible rather than blocking it on a comparison it cannot make.
 */

const base: Project = {
  id: 'p',
  name: 'p',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
}

const publication = (digest: string, videoId = digest): Publication => ({
  videoId,
  storagePath: `uid-1/${videoId}.mp4`,
  videoUrl: `https://cdn.example/uid-1/${videoId}.mp4`,
  digest,
  caption: null,
  publishedAt: '2026-08-11T12:00:00.000Z',
  accountId: 'uid-1',
  username: 'ada',
})

describe('publicationsOf', () => {
  it('reads a project saved before publishing existed as having posted nothing', () => {
    expect(publicationsOf(base)).toEqual([])
  })

  it('hands back what is there', () => {
    const project = { ...base, publications: [publication('aaa')] }
    expect(publicationsOf(project)).toHaveLength(1)
  })
})

describe('publishedAs', () => {
  const project: Project = { ...base, publications: [publication('aaa'), publication('bbb')] }

  it('finds the post an identical export already went up as', () => {
    expect(publishedAs(project, 'bbb')?.videoId).toBe('bbb')
  })

  it('finds nothing for an export that differs, which is a new video', () => {
    expect(publishedAs(project, 'ccc')).toBeUndefined()
  })

  it('finds nothing at all for a project that has posted nothing', () => {
    expect(publishedAs(base, 'aaa')).toBeUndefined()
  })

  it('matches nothing rather than everything when there is no digest', () => {
    // A browser that would not hash must still be able to publish. Matching
    // here would make an unhashable one unable to post at all, which is a
    // worse failure than the duplicate it would be guarding against.
    expect(publishedAs(project, null)).toBeUndefined()
  })

  it('does not match a record written without a digest', () => {
    const older: Project = { ...base, publications: [publication('')] }
    expect(publishedAs(older, '')).toBeUndefined()
  })
})
