import { describe, expect, it } from 'vitest'
import { daysLeft, fromStored, RETENTION_DAYS, toDoc } from './projects'
import { defaultCaptionStyle } from '../captions'
import type { CaptionCue, CaptionTrack, Project } from '../types'

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

  it('drops the keys again when the last caption is deleted', () => {
    // The document is replaced wholesale on every save, so omitting an empty
    // list is how a deletion reaches the server rather than being ignored.
    const doc = toDoc(project({ captionTracks: [], captionCues: [] }))
    expect('captionCues' in doc).toBe(false)
  })

  it('keeps a caption track that has been emptied of captions', () => {
    const doc = toDoc(project({ captionTracks: [track], captionCues: [] }))
    expect(doc.captionTracks).toEqual([track])
    expect('captionCues' in doc).toBe(false)
  })
})

describe('a project through a save and an open', () => {
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
