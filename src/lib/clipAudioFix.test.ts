import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneNameFor, fixClipAudio, fixTargets, layoutSpokenLines } from './clipAudioFix'
import { isAppClone } from '../../netlify/lib/elevenlabs'
import type { Asset, AudioClip, CaptionCue, Clip, Project } from './types'

const cloneVoice = vi.fn<(options: { name: string; sample: Blob }) => Promise<string>>()
interface SpeakArgs {
  voiceId: string
  text: string
  languageCode?: string
  previousText?: string
  nextText?: string
}
const speak = vi.fn<(options: SpeakArgs) => Promise<{ blob: Blob; words: unknown[] }>>()
const deleteVoice = vi.fn<(voiceId: string) => Promise<void>>()

vi.mock('./elevenlabs', () => ({
  cloneVoice: (options: { name: string; sample: Blob }) => cloneVoice(options),
  speak: (options: SpeakArgs) => speak(options),
  deleteVoice: (voiceId: string) => deleteVoice(voiceId),
}))

/**
 * Decoding is the browser's, and jsdom has no audio in it. What matters at this
 * level is which stretch of the clip gets cut out, so the mock records the range
 * rather than producing samples.
 */
const monoWav = vi.fn<(buffer: unknown, range: { from: number; to: number }) => Promise<Blob>>()

vi.mock('./speechAudio', () => ({
  decodeAudio: () => Promise.resolve({ duration: 12, sampleRate: 48000 }),
  monoWav: (buffer: unknown, range: { from: number; to: number }) => monoWav(buffer, range),
}))

const asset = (id: string, kind: Asset['kind'], name = `${id}.file`): Asset => ({
  id,
  kind,
  blobKey: `blob-${id}`,
  mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  name,
  duration: 10,
  createdAt: 0,
})

const clip = (id: string, assetId: string, extra: Partial<Clip> = {}): Clip => ({
  id,
  assetId,
  inPoint: 0,
  outPoint: 4,
  ...extra,
})

const cue = (id: string, sourceId: string, text: string, start: number): CaptionCue => ({
  id,
  trackId: 'ctrack',
  start,
  end: start + 1,
  words: text.split(' ').map((word, index) => ({
    id: `${id}-${index}`,
    text: word,
    start: start + index * 0.1,
    end: start + index * 0.1 + 0.05,
  })),
  source: { id: sourceId, label: 'whatever it was called' },
})

const audioClip = (id: string, extra: Partial<AudioClip> = {}): AudioClip => ({
  id,
  trackId: 'atrack',
  assetId: `asset-${id}`,
  useConverted: false,
  startTime: 0,
  inPoint: 0,
  duration: 2,
  ...extra,
})

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
  ...overrides,
})

describe('fixTargets', () => {
  it('offers every clip with sound, and no stills', () => {
    const targets = fixTargets(project({ clips: [clip('c1', 'v1'), clip('c2', 'img')] }), [
      asset('v1', 'video'),
      asset('img', 'image'),
    ])
    expect([...targets.keys()]).toEqual(['c1'])
  })

  it('keeps offering a clip that has already been silenced', () => {
    // The whole point: muting the clip is what a fix does, so a fixed clip must
    // still be able to be fixed again. This is where it differs from captioning,
    // which skips anything that is not in the finished mix.
    const targets = fixTargets(project({ clips: [clip('c1', 'v1', { muted: true })] }), [
      asset('v1', 'video'),
    ])
    expect(targets.get('c1')).toBeDefined()
  })

  it('leaves out a clip whose media is missing from the library', () => {
    const targets = fixTargets(project({ clips: [clip('c1', 'gone')] }), [])
    expect(targets.size).toBe(0)
  })

  it('places each clip where it really starts, lead-in and transitions included', () => {
    const targets = fixTargets(
      project({
        leadIn: 2,
        clips: [
          clip('c1', 'v1'),
          clip('c2', 'v1', { transition: { kind: 'dissolve', duration: 1 } }),
        ],
      }),
      [asset('v1', 'video')],
    )
    expect(targets.get('c1')?.startTime).toBeCloseTo(2)
    // Four seconds of the first clip, less the second overlapping it by one.
    expect(targets.get('c2')?.startTime).toBeCloseTo(5)
  })

  it('takes this clip’s captions as the script, in the order they are spoken', () => {
    const targets = fixTargets(
      project({
        clips: [clip('c1', 'v1')],
        captionCues: [
          cue('b', 'c1', 'como estas', 1),
          cue('a', 'c1', 'buenos dias', 0),
          cue('c', 'c2', 'a different clip', 0),
        ],
      }),
      [asset('v1', 'video')],
    )
    // One line per caption, each with the mark the picture says it on — which
    // is the whole reason the captions are the script rather than a hint.
    expect(targets.get('c1')?.lines).toEqual([
      { cueId: 'a', start: 0, end: 1, text: 'buenos dias' },
      { cueId: 'b', start: 1, end: 2, text: 'como estas' },
    ])
    expect(targets.get('c1')?.text).toBe('buenos dias como estas')
  })

  it('lets the captions overrule an older correction, since they are where it was written', () => {
    const targets = fixTargets(
      project({
        clips: [clip('c1', 'v1')],
        captionCues: [cue('a', 'c1', 'Buenos días', 0)],
        audioClips: [
          audioClip('fixed', {
            anchorClipId: 'c1',
            speechFix: { text: 'something older', language: 'es' },
          }),
          // Anchored to the same clip but not a fix: a line somebody recorded
          // over the shot is not what a redo starts from.
          audioClip('take', { anchorClipId: 'c1' }),
        ],
      }),
      [asset('v1', 'video')],
    )
    expect(targets.get('c1')).toMatchObject({
      text: 'Buenos días',
      language: 'es',
      fixedAudioClipId: 'fixed',
    })
  })

  it('falls back to the last correction where there are no captions at all', () => {
    const targets = fixTargets(
      project({
        clips: [clip('c1', 'v1')],
        audioClips: [audioClip('fixed', { anchorClipId: 'c1', speechFix: { text: 'Buongiorno' } })],
      }),
      [asset('v1', 'video')],
    )
    expect(targets.get('c1')?.lines).toEqual([])
    expect(targets.get('c1')?.text).toBe('Buongiorno')
  })

  it('says nothing has been fixed when nothing has', () => {
    const targets = fixTargets(project({ clips: [clip('c1', 'v1')] }), [asset('v1', 'video')])
    expect(targets.get('c1')?.fixedAudioClipId).toBeUndefined()
    expect(targets.get('c1')?.text).toBe('')
    expect(targets.get('c1')?.lines).toEqual([])
  })
})

describe('cloneNameFor', () => {
  it('names the clip it copied, and stays inside ElevenLabs’ name limit', () => {
    expect(cloneNameFor('lighthouse.mp4')).toContain('lighthouse.mp4')
    expect(cloneNameFor('x'.repeat(300)).length).toBeLessThanOrEqual(100)
  })

  it('is a name the proxy will recognise as this app’s own', () => {
    // The two ends of this string live in directories that cannot both be
    // compiled together — the functions build has no `src` in it — so this is
    // the one place both halves are imported and checked against each other.
    // The day they disagree is the day the proxy starts refusing to delete the
    // app's own leftover clones, and voice slots quietly fill up.
    expect(isAppClone(cloneNameFor('lighthouse.mp4'))).toBe(true)
    expect(isAppClone(cloneNameFor('x'.repeat(300)))).toBe(true)
  })
})

describe('layoutSpokenLines', () => {
  it('starts every line where its caption starts', () => {
    expect(
      layoutSpokenLines([
        { start: 0, duration: 0.8 },
        { start: 1, duration: 0.5 },
        { start: 2, duration: 1 },
      ]),
    ).toEqual([
      { start: 0, pushed: false },
      { start: 1, pushed: false },
      { start: 2, pushed: false },
    ])
  })

  it('pushes a line that would land on the one still being said', () => {
    // The new reading is slower than the performance it replaces. Two voices at
    // once is unlistenable, and one lane cannot hold overlapping clips anyway,
    // so it waits — and says it waited.
    expect(
      layoutSpokenLines([
        { start: 0, duration: 1.5 },
        { start: 1, duration: 0.5 },
        { start: 3, duration: 0.5 },
      ]),
    ).toEqual([
      { start: 0, pushed: false },
      { start: 1.5, pushed: true },
      { start: 3, pushed: false },
    ])
  })

  it('does not call a rounding error a push', () => {
    const placed = layoutSpokenLines([
      { start: 0, duration: 1 },
      { start: 0.9999, duration: 1 },
    ])
    expect(placed[1]).toEqual({ start: 0.9999, pushed: false })
  })

  it('has nothing to say about nothing', () => {
    expect(layoutSpokenLines([])).toEqual([])
  })
})

describe('fixClipAudio', () => {
  const media = new Blob(['media'], { type: 'video/mp4' })
  const request = {
    media,
    inPoint: 1,
    duration: 4,
    lines: ['  Buongiorno  '],
    label: 'lighthouse.mp4',
  }

  beforeEach(() => {
    cloneVoice.mockReset().mockResolvedValue('cloned-voice')
    speak.mockReset().mockImplementation(({ text }) =>
      Promise.resolve({
        blob: new Blob([text], { type: 'audio/mpeg' }),
        words: [{ text, start: 0, end: 0.5 }],
      }),
    )
    deleteVoice.mockReset().mockResolvedValue(undefined)
    monoWav.mockReset().mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' }))
  })

  it('copies the clip’s voice, says the line in it, and deletes the copy again', async () => {
    const result = await fixClipAudio({ ...request, language: 'it' })

    expect(monoWav).toHaveBeenCalledWith(expect.anything(), { from: 1, to: 5 })
    expect(cloneVoice).toHaveBeenCalledWith(
      expect.objectContaining({ name: cloneNameFor('lighthouse.mp4') }),
    )
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'cloned-voice', text: 'Buongiorno', languageCode: 'it' }),
    )
    // A voice left in the account counts against the site's own slots.
    expect(deleteVoice).toHaveBeenCalledWith('cloned-voice')
    expect(result.spoken).toHaveLength(1)
    expect(result.spoken[0]?.words).toEqual([{ text: 'Buongiorno', start: 0, end: 0.5 }])
  })

  it('says each caption on its own, and hands the neighbours over for context', async () => {
    // One request per line is what lets each one be laid on its own mark. The
    // neighbours are not spoken; without them every line lands on a full stop
    // and the clip comes back sounding like a list.
    const result = await fixClipAudio({
      ...request,
      lines: ['Buongiorno.', 'Come stai?', 'Bene, grazie.'],
    })

    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls.map((call) => call[0].text)).toEqual([
      'Buongiorno.',
      'Come stai?',
      'Bene, grazie.',
    ])
    expect(speak.mock.calls[1]?.[0]).toMatchObject({
      previousText: 'Buongiorno.',
      nextText: 'Bene, grazie.',
    })
    expect(speak.mock.calls[0]?.[0].previousText).toBeUndefined()
    expect(speak.mock.calls[2]?.[0].nextText).toBeUndefined()
    expect(result.spoken.map((line) => line.text)).toEqual([
      'Buongiorno.',
      'Come stai?',
      'Bene, grazie.',
    ])
  })

  it('copies the voice once, however many lines there are', async () => {
    await fixClipAudio({ ...request, lines: ['One.', 'Two.', 'Three.'] })
    expect(cloneVoice).toHaveBeenCalledTimes(1)
    expect(deleteVoice).toHaveBeenCalledTimes(1)
  })

  it('never sends a language when none was chosen', async () => {
    await fixClipAudio(request)
    expect(speak.mock.calls[0]?.[0].languageCode).toBeUndefined()
  })

  it('takes no more of the clip than a clone needs', async () => {
    await fixClipAudio({ ...request, inPoint: 0, duration: 600 })
    // Capped at the sample length, and never past the end of the media either.
    expect(monoWav).toHaveBeenCalledWith(expect.anything(), { from: 0, to: 12 })
  })

  it('skips the copy entirely when a voice was chosen', async () => {
    const result = await fixClipAudio({ ...request, voiceId: 'rachel', voiceName: 'Rachel' })

    expect(cloneVoice).not.toHaveBeenCalled()
    expect(deleteVoice).not.toHaveBeenCalled()
    expect(speak.mock.calls[0]?.[0].voiceId).toBe('rachel')
    // Named, so the report can say who said it rather than "a voice".
    expect(result.voiceName).toBe('Rachel')
  })

  it('deletes the copy even when saying a line fails', async () => {
    speak.mockRejectedValue(new Error('out of credit'))
    await expect(fixClipAudio(request)).rejects.toThrow('out of credit')
    expect(deleteVoice).toHaveBeenCalledWith('cloned-voice')
  })

  it('refuses an empty script rather than spending a request on it', async () => {
    await expect(fixClipAudio({ ...request, lines: ['   ', ''] })).rejects.toThrow(/nothing to say/)
    expect(cloneVoice).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })

  it('reports each stage, and how far through the lines it is', async () => {
    const stages: string[] = []
    await fixClipAudio({
      ...request,
      lines: ['One.', 'Two.'],
      onStage: (stage, done, total) => stages.push(`${stage} ${done}/${total}`),
    })
    expect(stages).toEqual([
      'listening to the clip 0/2',
      'copying the voice 0/2',
      'saying the lines 0/2',
      'saying the lines 1/2',
    ])
  })
})
