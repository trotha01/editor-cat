import { describe, expect, it } from 'vitest'
import { fromStored, toDoc } from './projects'
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
