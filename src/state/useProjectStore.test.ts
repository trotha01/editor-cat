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

  it('carries a clip’s captions along when it is dragged somewhere else', () => {
    // 2s, 3s and 5s end to end, so the clips start at 0, 2 and 5. Each gets one
    // word, spoken inside its own clip and far enough from the others to be a
    // caption of its own.
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [
          { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 2 },
          { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 3 },
          { id: 'clip-3', assetId: 'c', inPoint: 0, outPoint: 5 },
        ],
      },
    })
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'One.', start: 0.5, end: 0.9, source: { id: 'clip-1', label: 'a.mp4' } },
      { text: 'Two.', start: 2.5, end: 2.9, source: { id: 'clip-2', label: 'b.mp4' } },
      { text: 'Three.', start: 5.5, end: 5.9, source: { id: 'clip-3', label: 'c.mp4' } },
    ])

    const startFor = (project: Project, clipId: string) =>
      captionCuesOf(project).find((cue) => cue.source?.id === clipId)?.start ?? NaN
    const before = useProjectStore.getState().project

    // Drag the last clip to the front: it leads now, and the other two follow.
    useProjectStore.getState().moveClip(2, 0)

    const saved = stored()
    expect(startFor(saved, 'clip-3') - startFor(before, 'clip-3')).toBeCloseTo(-5)
    expect(startFor(saved, 'clip-1') - startFor(before, 'clip-1')).toBeCloseTo(5)
    expect(startFor(saved, 'clip-2') - startFor(before, 'clip-2')).toBeCloseTo(5)
    // The words go with the line, or the highlight lands on the wrong one.
    const moved = captionCuesOf(saved).find((cue) => cue.source?.id === 'clip-3')
    expect(moved?.words[0]?.start).toBeCloseTo(0.5)
  })

  it('does not drag one clip’s captions along when a different clip is moved', () => {
    // Speech carrying on across the boundary: clip-1 runs 0-3 and its last word
    // lands at 2.7, clip-2 starts at 3 and its first word at 3.05. A tenth of a
    // second apart, so nothing but the change of clip separates them.
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [
          { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 3 },
          { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 5 },
        ],
      },
    })
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'the', start: 2.7, end: 2.95, source: { id: 'clip-1', label: 'a.mp4' } },
      { text: 'end', start: 3.05, end: 3.3, source: { id: 'clip-2', label: 'b.mp4' } },
    ])

    // Drag clip-2 to the front. It now plays 0-5, and clip-1 plays 5-8.
    useProjectStore.getState().moveClip(1, 0)

    const wordAt = (text: string) =>
      captionCuesOf(stored())
        .flatMap((cue) => cue.words)
        .find((word) => word.text === text)?.start ?? NaN
    // Each word follows the clip it was heard in. Before the clip boundary was
    // a break, both of these shared one cue credited to clip-1, so moving
    // clip-2 left its own word behind at 8.05 — out over clip-1.
    expect(wordAt('end')).toBeCloseTo(0.05)
    expect(wordAt('the')).toBeCloseTo(7.7)
  })

  it('hands the captions past a cut to the half that now holds them', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 10 }],
      },
    })
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'early', start: 1, end: 1.4, source: { id: 'clip-1', label: 'a.mp4' } },
      { text: 'late', start: 8, end: 8.4, source: { id: 'clip-1', label: 'a.mp4' } },
    ])

    // Cut at 5s: the half in front keeps clip-1, the half behind is a new clip.
    expect(useProjectStore.getState().cutAt(5)).toBe(true)
    const halves = useProjectStore.getState().project.clips
    expect(halves).toHaveLength(2)
    const credited = (text: string) =>
      captionCuesOf(useProjectStore.getState().project).find((cue) =>
        cue.words.some((word) => word.text === text),
      )?.source?.id
    expect(credited('early')).toBe(halves[0]!.id)
    expect(credited('late')).toBe(halves[1]!.id)

    // Swap the halves. Each caption goes with the half it belongs to; before
    // this, both were credited to clip-1 and "late" was carried off to 13s —
    // past the end of a ten-second project.
    useProjectStore.getState().moveClip(1, 0)
    const wordAt = (text: string) =>
      captionCuesOf(stored())
        .flatMap((cue) => cue.words)
        .find((word) => word.text === text)?.start ?? NaN
    expect(wordAt('late')).toBeCloseTo(3)
    expect(wordAt('early')).toBeCloseTo(6)
  })

  it('leaves a voiceover’s captions where they are when the picture is rearranged', () => {
    // A voice clip sits at its own time and does not move when clips are
    // reordered, so its words must not move either.
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [
          { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 2 },
          { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 3 },
        ],
      },
    })
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore
      .getState()
      .setCaptionsFromWords(trackId, [
        { text: 'Narration.', start: 0.5, end: 0.9, source: { id: 'aclip-1', label: 'take.webm' } },
      ])
    const before = captionCuesOf(useProjectStore.getState().project)[0]

    useProjectStore.getState().moveClip(1, 0)

    expect(captionCuesOf(stored())[0]).toBe(before)
  })

  it('carries a voiceover and a count-in with the clip they were laid against', () => {
    // clip-1 over 0-3, clip-2 over 3-8.
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [
          { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 3 },
          { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 5 },
        ],
      },
    })
    const base = { assetId: 'rec', useConverted: false, inPoint: 0, duration: 1 }
    // A line read a second into clip-2, and a count-in leading into it.
    useProjectStore.getState().addAudioClip('voice', { ...base, startTime: 4 })
    useProjectStore.getState().addAudioClip('countdown', { ...base, startTime: 3.5 })
    // A music bed laid under the whole thing.
    useProjectStore.getState().addAudioClip('music', { ...base, startTime: 0, duration: 8 })

    // Drag clip-2 to the front: it now plays 0-5, clip-1 plays 5-8.
    useProjectStore.getState().moveClip(1, 0)

    const byStart = stored()
      .audioClips.slice()
      .sort((a, b) => a.startTime - b.startTime)
    const voice = byStart.find((clip) => clip.anchorClipId === 'clip-2' && clip.duration === 1)
    // Both were laid against clip-2 and keep their offset into it: the count-in
    // half a second in, the line a second in.
    expect(stored().audioClips.filter((c) => c.anchorClipId === 'clip-2')).toHaveLength(2)
    expect(voice).toBeDefined()
    const offsets = stored()
      .audioClips.filter((clip) => clip.anchorClipId === 'clip-2')
      .map((clip) => clip.startTime)
      .sort((a, b) => a - b)
    expect(offsets[0]).toBeCloseTo(0.5)
    expect(offsets[1]).toBeCloseTo(1)

    // The music bed belongs to the piece, not to a shot, so it does not move.
    const music = stored().audioClips.find((clip) => clip.duration === 8)
    expect(music?.anchorClipId).toBeUndefined()
    expect(music?.startTime).toBe(0)
  })

  it('leaves audio dropped past the end of the picture unanchored', () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [{ id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 3 }],
      },
    })
    // Read over black after the picture ends: there is no shot to belong to.
    useProjectStore.getState().addAudioClip('voice', {
      assetId: 'rec',
      useConverted: false,
      inPoint: 0,
      duration: 1,
      startTime: 10,
    })
    expect(stored().audioClips[0]?.anchorClipId).toBeUndefined()
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
