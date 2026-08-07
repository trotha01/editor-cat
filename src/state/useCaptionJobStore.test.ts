/**
 * Captioning one clip from its own menu.
 *
 * The rule worth pinning down here is the one that is invisible when it works:
 * a clip that fails to transcribe must come back with the captions it already
 * had. `transcribeTimeline` reports a failed source rather than throwing, so
 * nothing further up would notice a network fault — and the run that "finished
 * with no words" would quietly delete the very captions it was asked to improve.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCaptionJobStore } from './useCaptionJobStore'
import { emptyProject, useProjectStore } from './useProjectStore'
import { captionCuesOf } from '../lib/captions'
import type { TimelineTranscript } from '../lib/transcribeTimeline'
import type { SpeechSource } from '../lib/captionSources'

const transcribeTimeline =
  vi.fn<(options: { signal?: AbortSignal }) => Promise<TimelineTranscript>>()

vi.mock('../lib/transcribeTimeline', () => ({
  transcribeTimeline: (options: { signal?: AbortSignal }) => transcribeTimeline(options),
}))

vi.mock('../lib/db', () => ({
  saveProject: () => Promise.resolve(),
  loadProject: () => Promise.resolve(undefined),
}))

const CLIP_A: SpeechSource = {
  id: 'clip-a',
  label: 'take-1.webm',
  assetId: 'asset-a',
  startTime: 0,
  inPoint: 0,
  duration: 2,
}

const heard = (clipId: string, text: string, start: number, end: number) => ({
  text,
  start,
  end,
  source: { id: clipId, label: `${clipId}.webm` },
})

/** A project captioned from two clips, which is what makes "only this one" mean anything. */
function captioned(): string {
  const trackId = useProjectStore.getState().ensureCaptionTrack()
  useProjectStore
    .getState()
    .setCaptionsFromWords(trackId, [
      heard('clip-a', 'First', 0, 0.4),
      heard('clip-a', 'take.', 0.5, 0.9),
      heard('clip-b', 'Second', 3, 3.4),
      heard('clip-b', 'take.', 3.5, 3.9),
    ])
  return trackId
}

const transcript = (over: Partial<TimelineTranscript> = {}): TimelineTranscript => ({
  words: [],
  failures: [],
  languages: [],
  ...over,
})

beforeEach(() => {
  transcribeTimeline.mockReset()
  useProjectStore.setState({ project: emptyProject(), selectedCaption: null })
  useCaptionJobStore.setState({ clipId: null, label: '', progress: null, outcome: null })
})

describe('captioning one clip', () => {
  it('replaces that clip’s captions and says what landed', async () => {
    captioned()
    transcribeTimeline.mockResolvedValue(
      transcript({
        words: [heard('clip-a', 'Better', 0, 0.4), heard('clip-a', 'take.', 0.5, 0.9)],
        languages: ['eng'],
      }),
    )

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    const cues = captionCuesOf(useProjectStore.getState().project)
    expect(
      cues.filter((cue) => cue.source?.id === 'clip-a').flatMap((cue) => cue.words)[0]?.text,
    ).toBe('Better')
    expect(cues.filter((cue) => cue.source?.id === 'clip-b')).toHaveLength(1)

    const { outcome, clipId } = useCaptionJobStore.getState()
    expect(clipId).toBeNull()
    expect(outcome?.tone).toBe('success')
    expect(outcome?.text).toContain('take-1.webm')
    expect(outcome?.text).toContain('replaced 1 caption')
  })

  it('leaves a clip that could not be transcribed exactly as it was', async () => {
    captioned()
    const before = captionCuesOf(useProjectStore.getState().project)
    transcribeTimeline.mockResolvedValue(
      transcript({ failures: ['take-1.webm: the network dropped'] }),
    )

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    // By identity: a failed run must not so much as rewrite the cues it kept.
    expect(captionCuesOf(useProjectStore.getState().project)).toEqual(before)
    const { outcome } = useCaptionJobStore.getState()
    expect(outcome?.tone).toBe('warn')
    expect(outcome?.detail).toContain('the network dropped')
  })

  it('warns rather than ticks when the clip turns out to have no speech', async () => {
    captioned()
    transcribeTimeline.mockResolvedValue(transcript())

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    expect(captionCuesOf(useProjectStore.getState().project)).toHaveLength(1)
    expect(useCaptionJobStore.getState().outcome?.tone).toBe('warn')
    expect(useCaptionJobStore.getState().outcome?.text).toContain('No speech was recognised')
  })

  it('reports what went wrong when the transcriber throws', async () => {
    transcribeTimeline.mockRejectedValue(new Error('Scribe is unavailable'))

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    expect(useCaptionJobStore.getState().outcome).toMatchObject({
      tone: 'error',
      text: 'Scribe is unavailable',
    })
  })

  it('says nothing at all when the run was cancelled, since the user asked', async () => {
    transcribeTimeline.mockImplementation((options) => {
      useCaptionJobStore.getState().cancel()
      return Promise.reject(
        options.signal?.aborted
          ? new DOMException('Aborted', 'AbortError')
          : new Error('was not cancelled'),
      )
    })

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    expect(useCaptionJobStore.getState().outcome).toBeNull()
    expect(useCaptionJobStore.getState().clipId).toBeNull()
  })

  it('ignores a second press while one is already running', async () => {
    let release = () => {}
    transcribeTimeline.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(transcript()))),
    )

    const first = useCaptionJobStore.getState().captionClip(CLIP_A)
    await useCaptionJobStore.getState().captionClip({ ...CLIP_A, id: 'clip-b' })
    expect(useCaptionJobStore.getState().clipId).toBe('clip-a')
    expect(transcribeTimeline).toHaveBeenCalledTimes(1)

    release()
    await first
  })

  it('transcribes as the language the Captions step is set to', async () => {
    useCaptionJobStore.setState({ language: 'spa' })
    transcribeTimeline.mockResolvedValue(transcript())

    await useCaptionJobStore.getState().captionClip(CLIP_A)

    expect(transcribeTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ languageCode: 'spa', sources: [CLIP_A] }),
    )
    useCaptionJobStore.setState({ language: '' })
  })
})
