import { describe, expect, it } from 'vitest'
import { publicationsOf, publishedAs, publishedFrom, sourceKeyOf } from './publications'
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
  publicationId: videoId,
  r2Prefix: `v1/uid-1/${videoId}/`,
  r2Keys: [`v1/uid-1/${videoId}/index.m3u8`],
  videoUrl: `https://cdn.example/v1/uid-1/${videoId}/index.m3u8`,
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

describe('sourceKeyOf', () => {
  it('is the same for the same timeline at the same settings', async () => {
    const one = await sourceKeyOf(base, { crf: 23 })
    const two = await sourceKeyOf({ ...base }, { crf: 23 })

    expect(one).toBe(two)
  })

  it('differs once the timeline changes', async () => {
    const edited: Project = {
      ...base,
      clips: [{ id: 'c1', assetId: 'a1', inPoint: 0, outPoint: 4 }],
    }

    expect(await sourceKeyOf(base, { crf: 23 })).not.toBe(await sourceKeyOf(edited, { crf: 23 }))
  })

  it('differs once the quality changes, which is a different file', async () => {
    expect(await sourceKeyOf(base, { crf: 23 })).not.toBe(await sourceKeyOf(base, { crf: 18 }))
  })

  it('differs once the frame size changes', async () => {
    const bigger: Project = { ...base, width: 1080, height: 1920 }

    expect(await sourceKeyOf(base, { crf: 23 })).not.toBe(await sourceKeyOf(bigger, { crf: 23 }))
  })

  it('differs once part of the timeline is exported rather than all of it', async () => {
    expect(await sourceKeyOf(base, { crf: 23 })).not.toBe(
      await sourceKeyOf(base, { crf: 23, range: { start: 2, end: 6 } }),
    )
  })

  it('tells one range from another', async () => {
    expect(await sourceKeyOf(base, { crf: 23, range: { start: 2, end: 6 } })).not.toBe(
      await sourceKeyOf(base, { crf: 23, range: { start: 2, end: 7 } }),
    )
  })

  it('is unchanged for a whole export, so nothing published stops matching', async () => {
    // The literal is the key this project hashed to before an export could be
    // trimmed at all, and it is pinned rather than derived on purpose: every
    // record already written carries a key like it, and an untrimmed export
    // that hashed to anything else would quietly make "already in the feed"
    // false for all of them.
    expect(await sourceKeyOf(base, { crf: 23 })).toBe(
      '857e31d5e929a604861937f43eb4003082659df44cf5e957f65fb3a80e47f77f',
    )
  })

  it('survives a rename, which does not change a single frame', async () => {
    const renamed: Project = { ...base, name: 'Something else' }

    expect(await sourceKeyOf(base, { crf: 23 })).toBe(await sourceKeyOf(renamed, { crf: 23 }))
  })

  it('survives publishing, or the post would hide the export it was made from', async () => {
    // Load-bearing: the publications list changes the moment something goes up,
    // so counting it would make every export unrecognisable immediately after
    // the publish that is supposed to make it recognisable.
    const after: Project = { ...base, publications: [publication('aaa')] }

    expect(await sourceKeyOf(base, { crf: 23 })).toBe(await sourceKeyOf(after, { crf: 23 }))
  })

  it('survives a round trip that reorders the document’s keys', async () => {
    // What Postgres `jsonb` does to a project on the way through Supabase. The
    // same timeline coming back from a sync must not read as a new video.
    const reordered = JSON.parse(
      JSON.stringify({
        fps: base.fps,
        height: base.height,
        width: base.width,
        audioClips: base.audioClips,
        audioTracks: base.audioTracks,
        clips: base.clips,
        name: base.name,
        id: base.id,
      }),
    ) as Project

    expect(await sourceKeyOf(base, { crf: 23 })).toBe(await sourceKeyOf(reordered, { crf: 23 }))
  })
})

describe('publishedFrom', () => {
  it('finds the post this timeline and these settings already went up as', async () => {
    const key = (await sourceKeyOf(base, { crf: 23 }))!
    const project: Project = { ...base, publications: [{ ...publication('aaa'), sourceKey: key }] }

    expect(publishedFrom(project, key)?.videoId).toBe('aaa')
  })

  it('finds nothing for a record kept before source keys existed', async () => {
    const key = (await sourceKeyOf(base, { crf: 23 }))!
    const project: Project = { ...base, publications: [publication('aaa')] }

    expect(publishedFrom(project, key)).toBeUndefined()
  })

  it('finds nothing when the key could not be worked out', () => {
    const project: Project = { ...base, publications: [publication('aaa')] }
    expect(publishedFrom(project, null)).toBeUndefined()
  })
})
