import { describe, expect, it } from 'vitest'
import { daysLeft, fromStored, RETENTION_DAYS, toDoc } from './projects'
import { captionCuesOf, captionTracksOf, defaultCaptionStyle } from '../captions'
import type { CaptionCue, CaptionTrack, Project, Publication } from '../types'

const track: CaptionTrack = {
  id: 'ctrack-1',
  name: 'Captions',
  hidden: false,
  style: defaultCaptionStyle(),
}

const cue: CaptionCue = {
  id: 'cue-1',
  trackId: 'ctrack-1',
  start: 1,
  end: 2.5,
  words: [
    { id: 'word-1', text: 'Hello', start: 1, end: 1.4 },
    { id: 'word-2', text: 'there', start: 1.5, end: 2 },
  ],
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'A project',
    clips: [{ id: 'clip-1', assetId: 'asset-1', inPoint: 0, outPoint: 4 }],
    audioTracks: [{ id: 'atrack-1', kind: 'voice', name: 'Voice 1', muted: false, volume: 1 }],
    audioClips: [],
    width: 720,
    height: 1280,
    fps: 30,
    ...overrides,
  }
}

const publication: Publication = {
  videoId: 'video-1',
  publicationId: 'export_abc',
  r2Prefix: 'v1/uid-1/export_abc/',
  r2Keys: ['v1/uid-1/export_abc/index.m3u8', 'v1/uid-1/export_abc/seg00000.m4s'],
  videoUrl: 'https://cdn.example/v1/uid-1/export_abc/index.m3u8',
  posterUrl: 'https://cdn.example/v1/uid-1/export_abc/poster.jpg',
  digest: 'deadbeef',
  sourceKey: 'cafebabe',
  caption: 'hello',
  publishedAt: '2026-08-11T12:00:00.000Z',
  accountId: 'uid-1',
  username: 'ada',
}

/**
 * A project with every optional field set.
 *
 * The point of it: `toDoc` decides what reaches the account, and a field it
 * does not carry is lost on the next open with nothing failing in between. A
 * fixture that only sets the fields somebody remembered proves only that those
 * are carried — which is how four of them (`videoTracks`, `videoClips`,
 * `libraryAssetIds`, `publications`) came to be dropped while the round-trip
 * test below sat there passing.
 */
function fullProject(): Project {
  return {
    ...project({ captionTracks: [track], captionCues: [cue] }),
    videoTracks: [{ id: 'vtrack-1', name: 'Overlay', hidden: false, opacity: 0.8 }],
    videoClips: [
      {
        id: 'vclip-1',
        trackId: 'vtrack-1',
        assetId: 'asset-2',
        startTime: 1,
        inPoint: 0,
        duration: 3,
        muted: true,
        volume: 0.5,
      },
    ],
    libraryAssetIds: ['asset-1', 'asset-2'],
    leadIn: 1.5,
    publications: [publication],
  }
}

/** What a save-then-open really does: split the document out, then put it back. */
function roundTrip(source: Project): Project {
  return fromStored({
    id: source.id,
    name: source.name,
    // Through JSON, because that is what a jsonb column is.
    doc: JSON.parse(JSON.stringify(toDoc(source))) as ReturnType<typeof toDoc>,
    schemaVersion: 3,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  })
}

describe('toDoc', () => {
  it('carries where each caption was transcribed from', () => {
    // Provenance is only worth recording if it outlives the session that
    // recorded it — and it rides inside the cue, so nothing in toDoc names it.
    const sourced = { ...cue, source: { id: 'clip-7', label: 'lion.mp4' } }
    const back = roundTrip(project({ captionTracks: [track], captionCues: [sourced] }))
    expect(back.captionCues?.[0]?.source).toEqual({ id: 'clip-7', label: 'lion.mp4' })
  })

  it('carries captions, word timings and all, so they survive a save', () => {
    const doc = toDoc(project({ captionTracks: [track], captionCues: [cue] }))
    expect(doc.captionTracks).toEqual([track])
    expect(doc.captionCues).toEqual([cue])
  })

  it('writes no caption keys at all for a project that has none', () => {
    // Documents saved before captions existed stay byte-identical, and an older
    // client reading one is unaffected.
    const doc = toDoc(project())
    expect('captionTracks' in doc).toBe(false)
    expect('captionCues' in doc).toBe(false)
  })

  /**
   * These two used to assert the key was *absent* for an empty list. It is now
   * carried as `[]`, and nothing can tell the difference: `captionCuesOf` and
   * `captionTracksOf` both read `?? NO_CUES` / `?? NO_TRACKS`, so absent and
   * empty are the same answer to every reader.
   *
   * The requirement underneath was never about the key. It is that the
   * document is replaced wholesale, so deleting the last caption has to reach
   * the server rather than leave the old ones there — which is what these
   * check now.
   */
  it('lets a deletion of the last caption reach the server', () => {
    const reopened = roundTrip(project({ captionTracks: [], captionCues: [] }))
    expect(captionCuesOf(reopened)).toEqual([])
  })

  it('keeps a caption track that has been emptied of captions', () => {
    const reopened = roundTrip(project({ captionTracks: [track], captionCues: [] }))
    expect(captionTracksOf(reopened)).toEqual([track])
    expect(captionCuesOf(reopened)).toEqual([])
  })
})

describe('a project through a save and an open', () => {
  it('comes back whole, every field of it', () => {
    // The assertion that matters, against a project that actually has
    // something in every field. Anything `toDoc` fails to carry is not an
    // error anywhere — the edit works, the save reports success, and the loss
    // shows up on the next open, on this machine or another.
    const source = fullProject()

    expect(roundTrip(source)).toEqual(source)
  })

  it('keeps a published video published', () => {
    // Named on its own because of what it costs when it goes. `publications`
    // is what answers "is this already in the feed?", so losing it does not
    // look like data loss — it looks like the dedupe guard deciding this
    // export is new, and offers to put a second copy of the same video up.
    const reopened = roundTrip(fullProject())

    expect(reopened.publications).toEqual([publication])
  })

  it('keeps the picture layered over the picture', () => {
    const source = fullProject()
    const reopened = roundTrip(source)

    expect(reopened.videoTracks).toEqual(source.videoTracks)
    expect(reopened.videoClips).toEqual(source.videoClips)
  })

  it("keeps the project's own library", () => {
    // What the Library panel draws. Without it a second machine opens the
    // project with an empty library and no way to reach files it does hold.
    expect(roundTrip(fullProject()).libraryAssetIds).toEqual(['asset-1', 'asset-2'])
  })

  it('comes back with its captions identical', () => {
    const source = project({ captionTracks: [track], captionCues: [cue] })
    const reopened = roundTrip(source)

    expect(reopened.captionTracks).toEqual([track])
    expect(reopened.captionCues).toEqual([cue])
    // The whole document, in fact: this is the one place the shape is split up
    // and put back, so anything left out of `toDoc` is silently lost.
    expect(reopened).toEqual(source)
  })

  it('keeps the style a caption track was given', () => {
    const styled: CaptionTrack = {
      ...track,
      style: { ...defaultCaptionStyle(), fontScale: 0.12, highlightColor: '#ff0000', bold: false },
    }
    const reopened = roundTrip(project({ captionTracks: [styled], captionCues: [] }))
    expect(reopened.captionTracks?.[0]?.style).toEqual(styled.style)
  })

  it('loses nothing from a project that never had captions', () => {
    const source = project()
    expect(roundTrip(source)).toEqual(source)
  })
})

/**
 * How long a deleted project has left.
 *
 * Shown in the menu next to the way back, so it is a promise: whatever it says
 * is left has to still be restorable. The number is the client's own arithmetic
 * — the server decides the actual purge — so the rounding leans towards saying
 * less time than there is rather than more.
 */
describe('daysLeft', () => {
  const deletedAt = '2026-08-11T09:00:00Z'
  const at = (iso: string) => Date.parse(iso)

  it('gives the full window to something just deleted', () => {
    expect(daysLeft(deletedAt, at('2026-08-11T09:00:00Z'))).toBe(RETENTION_DAYS)
  })

  it('rounds a part day up, so a project never reads as gone while it is not', () => {
    // Eighty-nine days and an hour in. Saying "0 days left" next to a working
    // Restore button is the one answer that would be a lie.
    expect(daysLeft(deletedAt, at('2026-11-08T10:00:00Z'))).toBe(1)
  })

  it('counts down a day at a time', () => {
    expect(daysLeft(deletedAt, at('2026-08-12T09:00:00Z'))).toBe(89)
    expect(daysLeft(deletedAt, at('2026-09-10T09:00:00Z'))).toBe(60)
  })

  it('never goes negative for a row the purge has not caught up with', () => {
    // The sweep runs when a session starts, so a project can outlive its window
    // by however long its owner stays away.
    expect(daysLeft(deletedAt, at('2027-02-01T09:00:00Z'))).toBe(0)
  })
})
