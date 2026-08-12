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
import type { Asset, Project, Publication } from '../lib/types'

const PUBLICATION: Publication = {
  videoId: 'video-1',
  storagePath: 'uid-1/export_fixed.mp4',
  videoUrl: 'https://cdn.example/uid-1/export_fixed.mp4',
  digest: 'deadbeef',
  caption: 'hello',
  publishedAt: '2026-08-11T12:00:00.000Z',
  accountId: 'uid-1',
  username: 'ada',
}

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
  useProjectStore.setState({ project: emptyProject(), selectedCaption: null, past: [], future: [] })
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

describe('transitions reach storage, and carry the timeline with them', () => {
  /** Three clips of three seconds each, laid end to end. */
  const threeClips = () => ({
    ...emptyProject(),
    clips: [
      { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 3 },
      { id: 'clip-2', assetId: 'a', inPoint: 0, outPoint: 3 },
      { id: 'clip-3', assetId: 'a', inPoint: 0, outPoint: 3 },
    ],
  })

  it('saves a transition on the clip it comes into', () => {
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().setTransition('clip-2', { kind: 'dissolve', duration: 0.5 })

    expect(stored().clips.map((clip) => clip.transition)).toEqual([
      undefined,
      { kind: 'dissolve', duration: 0.5 },
      undefined,
    ])
  })

  it('refuses one on the first clip, which has no boundary in front of it', () => {
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().setTransition('clip-1', { kind: 'dissolve', duration: 0.5 })

    expect(stored().clips[0]?.transition).toBeUndefined()
  })

  it('clears one back to a straight cut, leaving no key behind', () => {
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().setTransition('clip-2', { kind: 'dissolve', duration: 0.5 })
    useProjectStore.getState().setTransition('clip-2', null)

    expect('transition' in (stored().clips[1] ?? {})).toBe(false)
  })

  it('puts one on every boundary but the first', () => {
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().setAllTransitions({ kind: 'iris', duration: 0.4 })

    expect(stored().clips.map((clip) => clip.transition?.kind)).toEqual([undefined, 'iris', 'iris'])
  })

  it('takes them all off again', () => {
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().setAllTransitions({ kind: 'iris', duration: 0.4 })
    useProjectStore.getState().setAllTransitions(null)

    expect(stored().clips.every((clip) => clip.transition === undefined)).toBe(true)
  })

  it('carries a take anchored to a shot that has just moved', () => {
    // The overlap pulls the third clip half a second earlier, and audio
    // performed against it belongs where that shot is now.
    useProjectStore.setState({ project: threeClips() })
    useProjectStore.getState().addAudioClip('voice', {
      assetId: 'rec',
      useConverted: false,
      inPoint: 0,
      duration: 1,
      startTime: 6,
    })
    expect(stored().audioClips[0]?.anchorClipId).toBe('clip-3')

    useProjectStore.getState().setTransition('clip-2', { kind: 'dissolve', duration: 0.5 })

    expect(stored().audioClips[0]?.startTime).toBeCloseTo(5.5)
  })
})

/**
 * Laying a corrected line under a clip.
 *
 * The two halves of a fix — the new audio arriving and the clip's own sound
 * going quiet — have to be one edit. Both playing together is the wrong line
 * under the right one, which is worse than either failure on its own, and an
 * undo that unpicked only half of it would leave a clip silent with nothing to
 * replace what it used to say.
 *
 * The other rule is that nothing generated is ever thrown away: a second go
 * lands on a lane of its own and quietens the one before it. Somebody paid for
 * that first take, and "which of these two readings is better" is a question
 * you can only answer with both of them still there.
 */
describe('fixed clip audio', () => {
  const twoClips = () => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        clips: [
          { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 3 },
          { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 5 },
        ],
      },
    })
  }

  const speech = (assetId: string, text: string) => ({
    assetId,
    useConverted: false,
    startTime: 3,
    inPoint: 0,
    duration: 2.5,
    label: 'Fixed: b.mp4',
    speechFix: { text, language: 'es' },
  })

  it('places the speech, mutes the clip, and anchors the two together', () => {
    twoClips()
    const placement = useProjectStore
      .getState()
      .addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])

    const laid = stored().audioClips
    expect(laid).toHaveLength(1)
    expect(laid[0]).toMatchObject({
      assetId: 'fix-1',
      anchorClipId: 'clip-2',
      startTime: 3,
      speechFix: { text: 'Hola', language: 'es' },
    })
    // On a voice lane, which is what the mixer treats as narration.
    const track = stored().audioTracks.find((entry) => entry.id === laid[0]?.trackId)
    expect(track?.kind).toBe('voice')
    expect(placement.trackName).toBe(track?.name)
    expect(placement.silenced).toBe(0)
    // And the clip it stands in for is silent, or both would play at once.
    expect(stored().clips.find((clip) => clip.id === 'clip-2')?.muted).toBe(true)
    expect(stored().clips.find((clip) => clip.id === 'clip-1')?.muted).toBeUndefined()
  })

  it('is one step, so a single undo puts the clip’s own sound back', () => {
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])

    useProjectStore.getState().undo()

    expect(useProjectStore.getState().project.audioClips).toEqual([])
    expect(
      useProjectStore.getState().project.clips.find((clip) => clip.id === 'clip-2')?.muted,
    ).toBeUndefined()
  })

  it('moves the captions onto the speech in the same edit as the audio', () => {
    // The captions describe the audio that has just arrived. Re-timing them
    // separately would mean an undo could take the audio away and leave the
    // words timed to something that is no longer there.
    twoClips()
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'Hola', start: 3, end: 3.4, source: { id: 'clip-2', label: 'b.mp4' } },
      { text: 'amigo', start: 3.5, end: 3.9, source: { id: 'clip-2', label: 'b.mp4' } },
    ])
    const cueId = captionCuesOf(useProjectStore.getState().project)[0]!.id
    const before = useProjectStore.getState().past.length

    useProjectStore.getState().addFixedClipAudio(
      'clip-2',
      [{ ...speech('fix-1', 'Hola amigo'), startTime: 3 }],
      [
        {
          cueId,
          offset: 3,
          words: [
            { text: 'Hola', start: 0, end: 0.6 },
            { text: 'amigo', start: 0.7, end: 1.4 },
          ],
        },
      ],
    )

    const cue = captionCuesOf(stored())[0]!
    expect(cue.words.map((word) => [word.start, word.end])).toEqual([
      [3, 3.6],
      [3.7, 4.4],
    ])
    // One step, so one undo returns the audio, the mute and the timings together.
    expect(useProjectStore.getState().past.length).toBe(before + 1)
    useProjectStore.getState().undo()
    expect(captionCuesOf(useProjectStore.getState().project)[0]?.words[0]?.start).toBe(3)
    expect(useProjectStore.getState().project.audioClips).toEqual([])
  })

  it('saves every edited caption as one step, before anything is spoken', () => {
    twoClips()
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'Hola', start: 3, end: 3.4 },
      { text: 'amigo', start: 3.5, end: 3.9 },
      { text: 'Adios', start: 6, end: 6.4 },
    ])
    const cues = captionCuesOf(useProjectStore.getState().project)
    const before = useProjectStore.getState().past.length

    useProjectStore.getState().setCueTexts([
      { cueId: cues[0]!.id, text: 'Buenos días' },
      // An emptied line is left as it was: this runs on the way to spending
      // money on the others, and a caption that has gone would take its place
      // in the script with it.
      { cueId: cues[1]!.id, text: '   ' },
    ])

    const after = captionCuesOf(stored())
    expect(after[0]?.words.map((word) => word.text)).toEqual(['Buenos', 'días'])
    expect(after[1]?.words.map((word) => word.text)).toEqual(cues[1]?.words.map((w) => w.text))
    // Typed together and pressed once, so undone once.
    expect(useProjectStore.getState().past.length).toBe(before + 1)
  })

  it('puts every line of one fix on the same new lane', () => {
    // A fix is one piece per caption, laid where each caption starts. They
    // belong together: one lane, one mute, one undo.
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [
      { ...speech('line-1', 'Hola'), startTime: 3 },
      { ...speech('line-2', '¿Cómo estás?'), startTime: 5 },
    ])

    const laid = stored().audioClips
    expect(laid.map((clip) => clip.assetId)).toEqual(['line-1', 'line-2'])
    expect(new Set(laid.map((clip) => clip.trackId)).size).toBe(1)
    expect(laid.every((clip) => clip.anchorClipId === 'clip-2')).toBe(true)
    expect(laid.map((clip) => clip.startTime)).toEqual([3, 5])
  })

  it('keeps the first take and gives the second a lane of its own', () => {
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])
    const second = useProjectStore
      .getState()
      .addFixedClipAudio('clip-2', [speech('fix-2', 'Buenos días')])

    // Nothing generated is overwritten: both readings are still on the timeline.
    expect(stored().audioClips.map((clip) => clip.assetId)).toEqual(['fix-1', 'fix-2'])
    const lanes = stored().audioClips.map((clip) => clip.trackId)
    expect(new Set(lanes).size).toBe(2)
    expect(second.silenced).toBe(1)
  })

  it('mutes the lane the earlier take is on, so only the newest is heard', () => {
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-2', 'Buenos días')])

    const laneOf = (assetId: string) =>
      stored().audioTracks.find(
        (track) =>
          track.id === stored().audioClips.find((clip) => clip.assetId === assetId)?.trackId,
      )
    expect(laneOf('fix-1')?.muted).toBe(true)
    expect(laneOf('fix-2')?.muted).toBe(false)
  })

  it('leaves a lane alone once something else is sharing it', () => {
    // Muting is only ever safe on a lane holding nothing but fixes. Drag a take
    // onto one and it stops being this feature's to silence.
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])
    const fixLane = stored().audioClips[0]!.trackId
    useProjectStore.getState().addAudioClip('voice', {
      assetId: 'recording',
      useConverted: false,
      startTime: 20,
      inPoint: 0,
      duration: 1,
    })
    useProjectStore
      .getState()
      .updateAudioClip(stored().audioClips.find((clip) => clip.assetId === 'recording')!.id, {
        trackId: fixLane,
      })

    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-2', 'Buenos días')])

    expect(stored().audioTracks.find((track) => track.id === fixLane)?.muted).toBe(false)
  })

  it('leaves a take that happens to be anchored to the same clip alone', () => {
    twoClips()
    useProjectStore.getState().addAudioClip('voice', {
      assetId: 'recording',
      useConverted: false,
      startTime: 4,
      inPoint: 0,
      duration: 1,
    })
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-2', 'Buenos días')])

    // Somebody's recording is not a fix, however close it is sitting, so the
    // lane it is on is never the one a later fix quietens.
    const recordingLane = stored().audioClips.find((clip) => clip.assetId === 'recording')?.trackId
    expect(stored().audioTracks.find((track) => track.id === recordingLane)?.muted).toBe(false)
  })

  it('carries the correction with the clip when the picture is rearranged', () => {
    twoClips()
    useProjectStore.getState().addFixedClipAudio('clip-2', [speech('fix-1', 'Hola')])

    // clip-2 now plays first, so its line has to move with it.
    useProjectStore.getState().moveClip(1, 0)

    expect(stored().audioClips[0]?.startTime).toBeCloseTo(0)
  })
})

/**
 * Where a clip added from the library lands, and what has to come with it.
 *
 * Inserting into the middle of the run is the one clip edit that makes the
 * picture longer as well as rearranging it, so everything past the insertion
 * point that is timed in absolute seconds — captions, and the takes anchored to
 * a shot — has to be carried by exactly the length of what was inserted. The
 * failure this is here to catch is the sound staying put while the picture
 * slides out from under it, which is silent until you play the thing back.
 */
describe('a clip added at the playhead', () => {
  const asset: Asset = {
    id: 'a-new',
    kind: 'video',
    blobKey: 'b-new',
    mimeType: 'video/mp4',
    name: 'new.mp4',
    duration: 4,
    createdAt: 0,
  }

  /** Three shots of 2s, 3s and 5s, so they run 0–2, 2–5 and 5–10. */
  const threeShots = (): Project => ({
    ...emptyProject(),
    clips: [
      { id: 'clip-1', assetId: 'a', inPoint: 0, outPoint: 2 },
      { id: 'clip-2', assetId: 'b', inPoint: 0, outPoint: 3 },
      { id: 'clip-3', assetId: 'c', inPoint: 0, outPoint: 5 },
    ],
  })

  /** What was inserted, which is whatever is not one of the three shots. */
  const added = () => stored().clips.filter((clip) => !clip.id.startsWith('clip-'))

  it('lands after the clip the playhead is over rather than on the end', () => {
    useProjectStore.setState({ project: threeShots() })

    // A second into the first shot.
    useProjectStore.getState().addClip(asset, 1)

    const order = stored().clips.map((clip) => (clip.id.startsWith('clip-') ? clip.id : 'added'))
    expect(order).toEqual(['clip-1', 'added', 'clip-2', 'clip-3'])
    // Selected, so the next edit lands on what was just added.
    expect(useProjectStore.getState().selectedClipId).toBe(added()[0]?.id)
  })

  it('carries the captions behind it by the length of what was inserted', () => {
    useProjectStore.setState({ project: threeShots() })
    const trackId = useProjectStore.getState().ensureCaptionTrack()
    useProjectStore.getState().setCaptionsFromWords(trackId, [
      { text: 'One.', start: 0.5, end: 0.9, source: { id: 'clip-1', label: 'a.mp4' } },
      { text: 'Two.', start: 2.5, end: 2.9, source: { id: 'clip-2', label: 'b.mp4' } },
      { text: 'Three.', start: 5.5, end: 5.9, source: { id: 'clip-3', label: 'c.mp4' } },
    ])

    useProjectStore.getState().addClip(asset, 1)

    const startFor = (clipId: string) =>
      captionCuesOf(stored()).find((cue) => cue.source?.id === clipId)?.start ?? NaN
    // Four seconds of new picture between the first shot and the second. The
    // line spoken over the first is in front of it and does not move; the two
    // behind it move by exactly that much, each keeping its offset into its own
    // shot — half a second in.
    expect(startFor('clip-1')).toBeCloseTo(0.5)
    expect(startFor('clip-2')).toBeCloseTo(6.5)
    expect(startFor('clip-3')).toBeCloseTo(9.5)
  })

  it('carries the takes anchored behind it, and leaves the music where it was laid', () => {
    useProjectStore.setState({ project: threeShots() })
    const base = { assetId: 'rec', useConverted: false, inPoint: 0, duration: 1 }
    // A line read half a second into the second shot, a count-in leading into
    // the third, and a bed under the whole piece.
    useProjectStore.getState().addAudioClip('voice', { ...base, startTime: 2.5 })
    useProjectStore.getState().addAudioClip('countdown', { ...base, startTime: 6 })
    useProjectStore.getState().addAudioClip('music', { ...base, startTime: 0, duration: 10 })

    useProjectStore.getState().addClip(asset, 1)

    const startFor = (anchorClipId: string) =>
      stored().audioClips.find((clip) => clip.anchorClipId === anchorClipId)?.startTime ?? NaN
    expect(startFor('clip-2')).toBeCloseTo(6.5)
    expect(startFor('clip-3')).toBeCloseTo(10)
    // The bed belongs to the piece rather than to a shot, so four more seconds
    // of picture in front of it change nothing about where it starts.
    const music = stored().audioClips.find((clip) => clip.duration === 10)
    expect(music?.anchorClipId).toBeUndefined()
    expect(music?.startTime).toBe(0)
  })

  it('goes on the end from past the picture, and from inside a lead-in', () => {
    useProjectStore.setState({ project: threeShots() })
    useProjectStore.getState().addClip(asset, 99)
    expect(stored().clips.at(-1)?.id).toBe(added()[0]?.id)

    // The black in front of the first clip is not a position in the run: there
    // is no clip there to be after, and putting one in the gap would only close
    // it.
    useProjectStore.setState({ project: { ...threeShots(), leadIn: 4 } })
    useProjectStore.getState().addClip(asset, 2)
    expect(stored().clips).toHaveLength(4)
    expect(stored().clips.at(-1)?.id).toBe(added()[0]?.id)
  })

  it('goes on the end when nothing says where', () => {
    // What the Image and Video steps do: a clip generated there arrives with no
    // playhead to place it at, and lands where it always has.
    useProjectStore.setState({ project: threeShots() })

    useProjectStore.getState().addClip(asset)

    expect(
      stored()
        .clips.map((clip) => clip.id)
        .slice(0, 3),
    ).toEqual(['clip-1', 'clip-2', 'clip-3'])
    expect(stored().clips).toHaveLength(4)
  })
})

/**
 * The video lane stack: which lane a new layer lands on, and moving lanes along
 * the order afterwards.
 *
 * The order of `videoTracks` is the only record of what covers what — nothing on
 * a lane says where it sits — so an action that restacks without going through
 * `mutate` would look right until the project was reloaded and then quietly draw
 * the frame the other way up. That is why the order is read back out of storage
 * here rather than off the live store.
 */
describe('the video lane stack', () => {
  const still: Asset = {
    id: 'a-still',
    kind: 'image',
    blobKey: 'b',
    mimeType: 'image/png',
    name: 'logo.png',
    createdAt: 0,
  }

  /** A project with `count` empty lanes, bottom of the stack first. */
  const withLanes = (count: number) => {
    useProjectStore.setState({
      project: {
        ...emptyProject(),
        videoTracks: Array.from({ length: count }, (_unused, index) => ({
          id: `v${index + 1}`,
          name: `Video ${index + 1}`,
          hidden: false,
          opacity: 1,
        })),
        videoClips: [],
      },
      selectedVideoClipId: null,
    })
  }

  const laneIds = () => (stored().videoTracks ?? []).map((track) => track.id)

  it('moves a lane up the stack and writes the new order down', () => {
    withLanes(3)
    useProjectStore.getState().moveVideoTrack('v1', 'up')

    expect(laneIds()).toEqual(['v2', 'v1', 'v3'])
  })

  it('moves one back down again', () => {
    withLanes(3)
    useProjectStore.getState().moveVideoTrack('v3', 'down')

    expect(laneIds()).toEqual(['v1', 'v3', 'v2'])
  })

  it('leaves the top of the stack alone when it is pushed further up', () => {
    withLanes(2)
    useProjectStore.getState().moveVideoTrack('v2', 'up')

    expect(laneIds()).toEqual(['v1', 'v2'])
  })

  it('leaves every layer on the lane it was on', () => {
    // Restacking moves lanes, not their contents. A clip that changed lanes
    // would be a layer that moved in time as well as in depth.
    withLanes(2)
    useProjectStore.getState().addVideoClip(still, 0)
    const before = (stored().videoClips ?? []).map((clip) => [clip.id, clip.trackId])

    useProjectStore.getState().moveVideoTrack('v1', 'up')

    expect((stored().videoClips ?? []).map((clip) => [clip.id, clip.trackId])).toEqual(before)
  })

  it('puts a new layer on the highest lane with room, not the lowest', () => {
    // The bug this fixes: the lane search ran up the array, which is up from
    // the bottom of the stack, so a new layer landed under everything.
    withLanes(2)
    useProjectStore.getState().addVideoClip(still, 0)

    expect(stored().videoClips?.[0]?.trackId).toBe('v2')
  })

  it('makes a lane on top of the stack when every candidate is busy', () => {
    withLanes(1)
    useProjectStore.getState().addVideoClip(still, 0)
    useProjectStore.setState({ selectedVideoClipId: null })
    useProjectStore.getState().addVideoClip(still, 0)

    const lanes = laneIds()
    expect(lanes).toHaveLength(2)
    // The lane was made because there was nowhere high enough to put the layer,
    // so it has to be the last of them — anything else hands back the placement
    // it was made to avoid.
    expect(stored().videoClips?.[1]?.trackId).toBe(lanes[1])
  })

  it('never puts a layer under the one that is selected', () => {
    // The lower lane is free at that moment and the selected layer's lane is
    // not, so first-fit would slide the new layer in underneath it. Picking a
    // layer and then adding one means "over this".
    withLanes(2)
    useProjectStore.getState().addVideoClip(still, 0)
    expect(useProjectStore.getState().selectedVideoClipId).toBe(stored().videoClips?.[0]?.id)

    useProjectStore.getState().addVideoClip(still, 1)

    const lanes = laneIds()
    expect(lanes.indexOf(stored().videoClips?.[1]?.trackId ?? '')).toBeGreaterThan(
      lanes.indexOf('v2'),
    )
  })

  it('keeps using the selected layer’s own lane where there is room on it', () => {
    // Dropping a layer selects it, so without this every drop after the first
    // would spawn a lane and a row of stills would be a staircase of lanes.
    withLanes(2)
    useProjectStore.getState().addVideoClip(still, 0)
    useProjectStore.getState().addVideoClip(still, 10)

    expect(laneIds()).toEqual(['v1', 'v2'])
    expect(stored().videoClips?.map((clip) => clip.trackId)).toEqual(['v2', 'v2'])
  })

  it('still refuses an explicitly named lane that has no room', () => {
    // A drop onto a lane is a request, not a suggestion, and the search that
    // now prefers the top of the stack must not start quietly answering it.
    withLanes(2)
    useProjectStore.getState().addVideoClip(still, 0, 'v1')

    expect(useProjectStore.getState().addVideoClip(still, 0, 'v1')).toBeNull()
    expect(stored().videoClips).toHaveLength(1)
  })
})

describe('published videos', () => {
  it('remembers one, and writes it down', () => {
    useProjectStore.getState().recordPublication(PUBLICATION)

    expect(useProjectStore.getState().project.publications).toEqual([PUBLICATION])
    expect(stored().publications).toEqual([PUBLICATION])
  })

  it('keeps them in the order they went up', () => {
    const second = { ...PUBLICATION, videoId: 'video-2', digest: 'cafe' }
    useProjectStore.getState().recordPublication(PUBLICATION)
    useProjectStore.getState().recordPublication(second)

    expect(useProjectStore.getState().project.publications?.map((entry) => entry.videoId)).toEqual([
      'video-1',
      'video-2',
    ])
  })

  it('forgets one that has been deleted from the feed', () => {
    useProjectStore.getState().recordPublication(PUBLICATION)
    useProjectStore.getState().forgetPublication('video-1')

    expect(useProjectStore.getState().project.publications).toEqual([])
    expect(stored().publications).toEqual([])
  })

  it('does nothing for a video it was never tracking', () => {
    useProjectStore.getState().recordPublication(PUBLICATION)
    const before = useProjectStore.getState().project

    useProjectStore.getState().forgetPublication('never-heard-of-it')

    // The same object, so nothing downstream treats this as an edit to push.
    expect(useProjectStore.getState().project).toBe(before)
  })
})

describe('undo and redo', () => {
  const asset: Asset = {
    id: 'a-clip',
    kind: 'video',
    blobKey: 'b',
    mimeType: 'video/webm',
    name: 'take.webm',
    createdAt: 0,
  }

  it('is a no-op with nothing to undo or redo', () => {
    const before = useProjectStore.getState().project
    useProjectStore.getState().undo()
    useProjectStore.getState().redo()
    expect(useProjectStore.getState().project).toBe(before)
    expect(useProjectStore.getState().canUndo()).toBe(false)
    expect(useProjectStore.getState().canRedo()).toBe(false)
  })

  it('steps an edit back and forward again', () => {
    useProjectStore.getState().addClip(asset)
    const withOneClip = useProjectStore.getState().project
    useProjectStore.getState().addClip(asset)
    const withTwoClips = useProjectStore.getState().project

    expect(useProjectStore.getState().canUndo()).toBe(true)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project).toBe(withOneClip)
    expect(useProjectStore.getState().canRedo()).toBe(true)

    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project.clips).toEqual([])
    expect(useProjectStore.getState().canUndo()).toBe(false)

    useProjectStore.getState().redo()
    expect(useProjectStore.getState().project).toBe(withOneClip)
    useProjectStore.getState().redo()
    expect(useProjectStore.getState().project).toBe(withTwoClips)
    expect(useProjectStore.getState().canRedo()).toBe(false)
  })

  it('saves the project an undo restores, so a reload does not resurrect the edit', () => {
    useProjectStore.getState().addClip(asset)
    saveProject.mockClear()

    useProjectStore.getState().undo()

    expect(stored().clips).toEqual([])
  })

  it('drops the redo branch once a fresh edit is made', () => {
    useProjectStore.getState().addClip(asset)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().canRedo()).toBe(true)

    useProjectStore.getState().addClip(asset)

    expect(useProjectStore.getState().canRedo()).toBe(false)
  })

  it('does not record a step for an edit that hands back the same project', () => {
    useProjectStore.getState().addClip(asset)
    const before = useProjectStore.getState().past.length

    // No video clip has this id, so the trim is refused and the project
    // handed back by `mutate`'s callback is the very one it was given.
    useProjectStore.getState().trimVideoClipEdge('missing-id', undefined, 'start', 1)

    expect(useProjectStore.getState().past.length).toBe(before)
  })

  it('clears history when a different project is opened', async () => {
    useProjectStore.getState().addClip(asset)
    expect(useProjectStore.getState().canUndo()).toBe(true)

    await useProjectStore.getState().open('another-project')

    expect(useProjectStore.getState().canUndo()).toBe(false)
    expect(useProjectStore.getState().canRedo()).toBe(false)
  })

  it('does not forget a published video by stepping back past it', () => {
    // The history holds whole projects, so the step taken before publishing
    // still carries the empty list. Restoring it verbatim would forget a video
    // that is still in the feed — and forgetting it is what would let it be
    // posted a second time.
    useProjectStore.getState().addClip(asset)
    useProjectStore.getState().recordPublication(PUBLICATION)
    useProjectStore.getState().addClip(asset)

    useProjectStore.getState().undo()
    useProjectStore.getState().undo()

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    expect(useProjectStore.getState().project.publications).toEqual([PUBLICATION])
    expect(stored().publications).toEqual([PUBLICATION])
  })

  it('does not forget one by stepping forward again either', () => {
    useProjectStore.getState().addClip(asset)
    useProjectStore.getState().undo()
    useProjectStore.getState().recordPublication(PUBLICATION)
    useProjectStore.getState().redo()

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    expect(useProjectStore.getState().project.publications).toEqual([PUBLICATION])
  })

  it('leaves publishing off the undo stack, since Ctrl+Z cannot unpublish', () => {
    useProjectStore.getState().addClip(asset)
    useProjectStore.getState().recordPublication(PUBLICATION)

    // One edit, so one step: the publish did not add one of its own.
    useProjectStore.getState().undo()

    expect(useProjectStore.getState().canUndo()).toBe(false)
    expect(useProjectStore.getState().project.publications).toEqual([PUBLICATION])
  })

  it('drops a selection an undo brings back to nothing', () => {
    useProjectStore.getState().addClip(asset)
    const clipId = useProjectStore.getState().project.clips[0]!.id
    useProjectStore.getState().selectClip(clipId)
    useProjectStore.getState().removeClip(clipId)
    expect(useProjectStore.getState().selectedClipId).toBeNull()

    // Undoing the removal brings the clip back, but the selection was cleared
    // when it vanished and an undo does not go rummaging for it again.
    useProjectStore.getState().undo()

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    expect(useProjectStore.getState().selectedClipId).toBeNull()
  })
})
