/**
 * That caption edits are written down.
 *
 * Both durable paths hang off the same hook: `saveProject` puts the project in
 * IndexedDB, and `useProjectsStore` watches for the project object changing
 * identity and pushes it to Supabase. So an action that edits captions without
 * going through the store's `mutate` would be lost by both at once, silently and
 * only on the next reload — which is why every caption action is checked here
 * rather than a representative few.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProject, useProjectStore } from './useProjectStore'
import { captionCuesOf, captionTracksOf } from '../lib/captions'
import type { Project } from '../lib/types'

const saveProject = vi.fn<(project: Project) => Promise<void>>()

vi.mock('../lib/db', () => ({
  saveProject: (project: Project) => saveProject(project),
  loadProject: () => Promise.resolve(undefined),
}))

/** The project as it was last written to storage. */
function stored(): Project {
  const call = saveProject.mock.calls.at(-1)
  if (!call) throw new Error('nothing was saved')
  return call[0]
}

const WORDS = [
  { text: 'Hello', start: 0, end: 0.4 },
  { text: 'there', start: 0.5, end: 0.9 },
  { text: 'friend', start: 1, end: 1.4 },
  { text: 'again', start: 1.5, end: 1.9 },
  { text: 'today', start: 2, end: 2.4 },
]

/** A project with one caption track and a few captions on it. */
function withCaptions(): { trackId: string } {
  const trackId = useProjectStore.getState().ensureCaptionTrack()
  useProjectStore.getState().setCaptionsFromWords(trackId, WORDS)
  return { trackId }
}

beforeEach(() => {
  saveProject.mockClear()
  saveProject.mockResolvedValue(undefined)
  useProjectStore.setState({ project: emptyProject(), selectedCaption: null })
})

describe('captions reach storage', () => {
  it('saves the track the moment it is created', () => {
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    expect(captionTracksOf(stored()).map((track) => track.id)).toEqual([trackId])
  })

  it('saves a transcript, its captions and every word timing', () => {
    withCaptions()

    const cues = captionCuesOf(stored())
    expect(cues.length).toBeGreaterThan(0)
    expect(cues.flatMap((cue) => cue.words).map((word) => word.text)).toEqual(
      WORDS.map((word) => word.text),
    )
    // The timings specifically: a transcript without them is a subtitle, not a
    // karaoke caption, and they are the part with nothing else to derive from.
    for (const word of cues.flatMap((cue) => cue.words)) {
      expect(Number.isFinite(word.start)).toBe(true)
      expect(word.end).toBeGreaterThan(word.start)
    }
  })

  /**
   * Every edit, one at a time. Each runs on a freshly captioned project and is
   * checked for having both changed something and written it down.
   */
  const edits: [name: string, run: (trackId: string) => void, check: (saved: Project) => void][] = [
    [
      'retyping a word',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().setCueTextAt(cue.id, 'Hullo there')
      },
      (saved) => expect(captionCuesOf(saved)[0]?.words[0]?.text).toBe('Hullo'),
    ],
    [
      'retiming a word',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().setCueWordTiming(cue.id, cue.words[1]!.id, { start: 0.6 })
      },
      (saved) => expect(captionCuesOf(saved)[0]?.words[1]?.start).toBeCloseTo(0.6),
    ],
    [
      'moving a caption',
      () => {
        const cues = captionCuesOf(useProjectStore.getState().project)
        useProjectStore.getState().moveCueTo(cues.at(-1)!.id, 30)
      },
      (saved) => expect(captionCuesOf(saved).at(-1)?.start).toBe(30),
    ],
    [
      'trimming a caption',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().trimCueEdge(cue.id, 'start', 0.25)
      },
      (saved) => expect(captionCuesOf(saved)[0]?.start).toBeCloseTo(0.25),
    ],
    [
      'splitting a caption',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().splitCueAt(cue.id, 1)
      },
      (saved) => expect(captionCuesOf(saved).length).toBeGreaterThan(2),
    ],
    [
      'joining two captions',
      () => {
        const cues = captionCuesOf(useProjectStore.getState().project)
        useProjectStore.getState().mergeCueBack(cues[1]!.id)
      },
      (saved) => expect(captionCuesOf(saved).length).toBe(1),
    ],
    [
      'respacing a caption',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().respaceCue(cue.id)
      },
      (saved) => expect(captionCuesOf(saved)[0]?.words[0]?.start).toBeCloseTo(0),
    ],
    [
      'deleting a caption',
      () => {
        const cue = captionCuesOf(useProjectStore.getState().project)[0]!
        useProjectStore.getState().removeCue(cue.id)
      },
      (saved) => expect(captionCuesOf(saved).length).toBe(1),
    ],
    [
      'restyling the track',
      (trackId) => useProjectStore.getState().setCaptionStyle(trackId, { fontScale: 0.12 }),
      (saved) => expect(captionTracksOf(saved)[0]?.style.fontScale).toBe(0.12),
    ],
    [
      'hiding the track',
      (trackId) => useProjectStore.getState().updateCaptionTrack(trackId, { hidden: true }),
      (saved) => expect(captionTracksOf(saved)[0]?.hidden).toBe(true),
    ],
    [
      'deleting the track',
      (trackId) => useProjectStore.getState().removeCaptionTrack(trackId),
      (saved) => {
        expect(captionTracksOf(saved)).toEqual([])
        // Its captions go with it, or they would be saved forever with nothing
        // on screen to explain them.
        expect(captionCuesOf(saved)).toEqual([])
      },
    ],
  ]

  it.each(edits)('saves %s', (_name, run, check) => {
    const { trackId } = withCaptions()
    const before = useProjectStore.getState().project
    saveProject.mockClear()

    run(trackId)

    const after = useProjectStore.getState().project
    // Identity, not contents: this is precisely what `useProjectsStore`
    // subscribes to, so an edit that mutated in place would never be pushed.
    expect(after).not.toBe(before)
    expect(saveProject).toHaveBeenCalled()
    check(stored())
    expect(stored()).toBe(after)
  })

  /**
   * Redoing one clip is the one caption action that is defined by what it does
   * *not* touch, so it is checked on its own rather than in the table above: the
   * point is not merely that the new words were saved, but that the other clip's
   * line came back out of storage as the very object that went in.
   */
  it('saves one clip’s captions being redone, and keeps every other clip’s', () => {
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'First', start: 0, end: 0.4, source: { id: 'clip-a', label: 'take-1.webm' } },
      { text: 'take.', start: 0.5, end: 0.9, source: { id: 'clip-a', label: 'take-1.webm' } },
      { text: 'Second', start: 3, end: 3.4, source: { id: 'clip-b', label: 'take-2.webm' } },
      { text: 'take.', start: 3.5, end: 3.9, source: { id: 'clip-b', label: 'take-2.webm' } },
    ])
    const untouched = captionCuesOf(useProjectStore.getState().project).find(
      (cue) => cue.source?.id === 'clip-b',
    )!
    const before = useProjectStore.getState().project
    saveProject.mockClear()

    const result = useProjectStore.getState().setCaptionsFromSource(trackId, 'clip-a', [
      { text: 'Better', start: 0, end: 0.4, source: { id: 'clip-a', label: 'take-1.webm' } },
      { text: 'take.', start: 0.5, end: 0.9, source: { id: 'clip-a', label: 'take-1.webm' } },
    ])

    expect(result).toEqual({ added: 1, replaced: 1, dropped: 0 })
    expect(useProjectStore.getState().project).not.toBe(before)
    expect(saveProject).toHaveBeenCalled()

    const saved = captionCuesOf(stored())
    expect(
      saved
        .filter((cue) => cue.source?.id === 'clip-a')
        .flatMap((cue) => cue.words.map((entry) => entry.text)),
    ).toEqual(['Better', 'take.'])
    expect(saved.find((cue) => cue.source?.id === 'clip-b')).toBe(untouched)
    // Land on what just arrived, which is what a redo is asking to be shown.
    expect(useProjectStore.getState().selectedCaption?.cueId).toBe(
      saved.find((cue) => cue.source?.id === 'clip-a')?.id,
    )
  })

  it('leaves captions alone when the timeline is cleared', () => {
    // Clearing empties the picture and the audio. The captions belong to audio
    // that has gone, so they go too — but the track stays, ready to be used
    // again, which is what the caption lane surviving means.
    withCaptions()
    useProjectStore.getState().clearTimeline()

    expect(captionCuesOf(stored())).toEqual([])
    expect(captionTracksOf(stored()).length).toBe(1)
  })
})
