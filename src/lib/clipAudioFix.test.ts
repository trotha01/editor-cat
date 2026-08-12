import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dubbableSeconds,
  dubNameFor,
  fixClipAudio,
  fixTargets,
  hurriedLines,
  planSegments,
  splitAlignedWords,
} from './clipAudioFix'
import { isAppJob } from '../../netlify/lib/elevenlabs'
import type { Asset, AudioClip, CaptionCue, Clip, Project } from './types'

/**
 * A fake dubbing project, held the way the real transcript is: segments the
 * caller did not choose, which is the situation `planSegments` exists to
 * resolve.
 */
const dub = {
  segments: [] as { id: string; text: string; speakerId: string; start: number; end: number }[],
}

const createDubbingProject =
  vi.fn<(options: { reference: string; language: string }) => Promise<string>>()
const updateSegments =
  vi.fn<
    (
      id: string,
      edits: Record<string, { start: number; end: number; text: string }>,
    ) => Promise<void>
  >()
const createSegment =
  vi.fn<
    (
      id: string,
      speakerId: string,
      edit: { start: number; end: number; text: string },
    ) => Promise<string>
  >()
const deleteSegment = vi.fn<(id: string, segmentId: string) => Promise<void>>()
const createLanguageTarget = vi.fn<(id: string, language: string) => Promise<string>>()
const waitForDub = vi.fn<(id: string, languageId: string) => Promise<string>>()
const dubbedAudio = vi.fn<(url: string) => Promise<Blob>>()
const deleteDubbingProject = vi.fn<(id: string) => Promise<void>>()
const alignWords = vi.fn<(audio: Blob, text: string) => Promise<unknown[]>>()

vi.mock('./dubbing', () => ({
  createDubbingProject: (options: { reference: string; language: string }) =>
    createDubbingProject(options),
  waitForTranscript: () => Promise.resolve({ segments: dub.segments, revision: 1 }),
  updateSegments: (
    id: string,
    edits: Record<string, { start: number; end: number; text: string }>,
  ) => updateSegments(id, edits),
  createSegment: (
    id: string,
    speakerId: string,
    edit: { start: number; end: number; text: string },
  ) => createSegment(id, speakerId, edit),
  deleteSegment: (id: string, segmentId: string) => deleteSegment(id, segmentId),
  createLanguageTarget: (id: string, language: string) => createLanguageTarget(id, language),
  waitForDub: (id: string, languageId: string) => waitForDub(id, languageId),
  dubbedAudio: (url: string) => dubbedAudio(url),
  deleteDubbingProject: (id: string) => deleteDubbingProject(id),
  alignWords: (audio: Blob, text: string) => alignWords(audio, text),
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

describe('dubNameFor', () => {
  it('names the clip it was made for, and stays inside ElevenLabs’ name limit', () => {
    expect(dubNameFor('lighthouse.mp4')).toContain('lighthouse.mp4')
    expect(dubNameFor('x'.repeat(300)).length).toBeLessThanOrEqual(100)
  })

  it('is a name the proxy will recognise as this app’s own', () => {
    // The two ends of this string live in directories that cannot both be
    // compiled together — the functions build has no `src` in it — so this is
    // the one place both halves are imported and checked against each other.
    // The day they disagree is the day the proxy starts refusing to delete the
    // app's own finished jobs, and the account fills up with copies of clips.
    expect(isAppJob(dubNameFor('lighthouse.mp4'))).toBe(true)
    expect(isAppJob(dubNameFor('x'.repeat(300)))).toBe(true)
  })
})

describe('planSegments', () => {
  const at = (clipStart: number, duration: number) => ({ clipStart, duration })

  it('rewrites the segments it was given as the captions, on the captions’ own marks', () => {
    // The whole design in one assertion. The transcriber split this clip into
    // two spans of its own choosing; what comes out is those same two spans
    // saying the user's words, over the stretches the user's captions cover.
    const plan = planSegments(
      [
        { start: 10, end: 12, text: 'Buenos días' },
        { start: 12.5, end: 15, text: '¿Cómo estás?' },
      ],
      [{ id: 'seg_a' }, { id: 'seg_b' }],
      at(10, 6),
    )

    expect(plan.update).toEqual([
      { id: 'seg_a', start: 0, end: 2, text: 'Buenos días' },
      { id: 'seg_b', start: 2.5, end: 5, text: '¿Cómo estás?' },
    ])
    expect(plan.create).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('deletes the spans the transcriber found and the captions do not have', () => {
    // A caption is usually a sentence and a segment is usually a breath, so
    // this is the ordinary case rather than the odd one. Left alone, a spare
    // segment keeps the words the transcriber gave it and is then dubbed and
    // rendered — the clip saying something nobody typed.
    const plan = planSegments(
      [{ start: 0, end: 4, text: 'One long line' }],
      [{ id: 'seg_a' }, { id: 'seg_b' }, { id: 'seg_c' }],
      at(0, 4),
    )

    expect(plan.update).toEqual([{ id: 'seg_a', start: 0, end: 4, text: 'One long line' }])
    expect(plan.remove).toEqual(['seg_b', 'seg_c'])
  })

  it('creates the spans the transcriber missed', () => {
    const plan = planSegments(
      [
        { start: 0, end: 1, text: 'One' },
        { start: 1, end: 2, text: 'Two' },
        { start: 2, end: 3, text: 'Three' },
      ],
      [{ id: 'seg_a' }],
      at(0, 3),
    )

    expect(plan.update).toEqual([{ id: 'seg_a', start: 0, end: 1, text: 'One' }])
    expect(plan.create).toEqual([
      { start: 1, end: 2, text: 'Two' },
      { start: 2, end: 3, text: 'Three' },
    ])
    expect(plan.remove).toEqual([])
  })

  it('moves the captions onto the clip’s own clock', () => {
    // The uploaded audio is this clip and nothing else, so the two clocks differ
    // by exactly where the clip starts. Getting this wrong puts every line of a
    // clip late in the timeline outside its own media.
    const plan = planSegments([{ start: 30, end: 32, text: 'Hola' }], [{ id: 'seg_a' }], at(30, 5))
    expect(plan.update[0]).toMatchObject({ start: 0, end: 2 })
  })

  it('keeps a caption that runs past the end of its shot inside the clip', () => {
    // A caption may legitimately overhang the clip it belongs to. A segment may
    // not: there is no audio out there to put speech in.
    const plan = planSegments([{ start: 0, end: 9, text: 'Hola' }], [{ id: 'seg_a' }], at(0, 4))
    expect(plan.update[0]).toMatchObject({ start: 0, end: 4 })
  })

  it('gives a caption with no width something to be said in', () => {
    const plan = planSegments([{ start: 1, end: 1, text: 'Hola' }], [{ id: 'seg_a' }], at(0, 4))
    expect(plan.update[0]?.end).toBeGreaterThan(plan.update[0]?.start ?? 0)
  })

  it('has nothing to plan for nothing', () => {
    expect(planSegments([], [], at(0, 4))).toEqual({ update: [], create: [], remove: [] })
  })
})

describe('hurriedLines', () => {
  it('says nothing about lines that fit the room they were given', () => {
    expect(hurriedLines([{ start: 0, end: 3, text: 'Buenos días amigo' }]).count).toBe(0)
  })

  it('counts a line with more words than its caption has room for', () => {
    // The price of fixed generation, and the thing that replaces "this line
    // started late" as the warning worth giving. Nothing runs over; it gabbles.
    const hurried = hurriedLines([
      { start: 0, end: 1, text: 'Buenos días amigo, ¿cómo estás esta mañana tan bonita?' },
      { start: 1, end: 4, text: 'Bien.' },
    ])
    expect(hurried.count).toBe(1)
    expect(hurried.peak).toBeGreaterThan(17)
  })

  it('ignores an empty line rather than calling it infinitely fast', () => {
    expect(hurriedLines([{ start: 0, end: 0, text: '' }])).toEqual({ count: 0, peak: 0 })
  })
})

describe('splitAlignedWords', () => {
  const words = 'a b c d e'
    .split(' ')
    .map((text, index) => ({ text, start: index, end: index + 1 }))

  it('hands each line the words it asked for, in order', () => {
    // The script was assembled from these very lines, so counting is exact —
    // and no arithmetic on the timestamps could be more right than that.
    expect(splitAlignedWords(['a b', 'c d e'], words)).toEqual([
      [words[0], words[1]],
      [words[2], words[3], words[4]],
    ])
  })

  it('leaves the lines it ran out of words for empty rather than wrong', () => {
    // A short answer costs those lines their re-timing, which the caller reports
    // and carries on from. Redistributing would cost every line its accuracy.
    expect(splitAlignedWords(['a b', 'c d e'], words.slice(0, 2))).toEqual([
      [words[0], words[1]],
      [],
    ])
  })
})

describe('dubbableSeconds', () => {
  it('is the payload ceiling, in seconds of mono PCM', () => {
    // Where the one hard limit of this approach comes from: the clip has to
    // cross a serverless function to be dubbed at all.
    expect(dubbableSeconds(44100)).toBe(53)
    // A quieter source travels further, which is why the rate is not fixed.
    expect(dubbableSeconds(16000)).toBe(147)
  })
})

describe('fixClipAudio', () => {
  const media = new Blob(['media'], { type: 'video/mp4' })
  const request = {
    media,
    inPoint: 1,
    duration: 4,
    clipStart: 0,
    lines: [{ start: 0, end: 4, text: '  Buongiorno  ' }],
    language: 'it',
    label: 'lighthouse.mp4',
  }

  beforeEach(() => {
    dub.segments = [{ id: 'seg_a', text: 'whatever it heard', speakerId: 'sp_1', start: 0, end: 4 }]
    createDubbingProject.mockReset().mockResolvedValue('proj_1')
    updateSegments.mockReset().mockResolvedValue(undefined)
    createSegment
      .mockReset()
      .mockImplementation((_id, _speaker, edit) => Promise.resolve(`seg_new_${edit.start}`))
    deleteSegment.mockReset().mockResolvedValue(undefined)
    createLanguageTarget.mockReset().mockResolvedValue('lang_1')
    waitForDub.mockReset().mockResolvedValue('https://signed.example/dub.wav')
    dubbedAudio.mockReset().mockResolvedValue(new Blob(['mp3'], { type: 'audio/mpeg' }))
    deleteDubbingProject.mockReset().mockResolvedValue(undefined)
    alignWords.mockReset().mockResolvedValue([{ text: 'Buongiorno', start: 0.2, end: 1 }])
    monoWav.mockReset().mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' }))
  })

  it('sends the whole clip, writes the caption onto it, and brings back one track', async () => {
    const result = await fixClipAudio(request)

    // The whole clip, not a sample of it: this is the audio being re-voiced.
    expect(monoWav).toHaveBeenCalledWith(expect.anything(), { from: 1, to: 5 })
    expect(createDubbingProject).toHaveBeenCalledWith(
      expect.objectContaining({ reference: dubNameFor('lighthouse.mp4'), language: 'it' }),
    )
    expect(updateSegments).toHaveBeenCalledWith('proj_1', {
      seg_a: { start: 0, end: 4, text: 'Buongiorno' },
    })
    expect(createLanguageTarget).toHaveBeenCalledWith('proj_1', 'it')
    expect(dubbedAudio).toHaveBeenCalledWith('https://signed.example/dub.wav')
    // One piece of audio for the clip, where the old path returned one per line.
    expect(result.blob.type).toBe('audio/mpeg')
    expect(result.lines).toEqual([
      { text: 'Buongiorno', words: [{ text: 'Buongiorno', start: 0.2, end: 1 }] },
    ])
    // A project left behind holds a copy of the clip in the site's account.
    expect(deleteDubbingProject).toHaveBeenCalledWith('proj_1')
  })

  it('writes the script in before asking for it to be said', async () => {
    // The order that matters most in the whole run. A language target created
    // any earlier starts from the words the transcriber heard rather than the
    // ones the user typed, and then goes stale the moment a segment is
    // corrected.
    const order: string[] = []
    updateSegments.mockImplementation(() => {
      order.push('script')
      return Promise.resolve()
    })
    createLanguageTarget.mockImplementation(() => {
      order.push('speak')
      return Promise.resolve('lang_1')
    })

    await fixClipAudio(request)

    expect(order).toEqual(['script', 'speak'])
  })

  it('reconciles a segmentation that disagrees with the captions', async () => {
    // Three captions against two spans the transcriber found: two are rewritten
    // and the third is created. This is the ordinary case, not the odd one.
    dub.segments = [
      { id: 'seg_a', text: 'heard one', speakerId: 'sp_1', start: 0, end: 2 },
      { id: 'seg_b', text: 'heard two', speakerId: 'sp_1', start: 2, end: 4 },
    ]

    await fixClipAudio({
      ...request,
      lines: [
        { start: 0, end: 1, text: 'One.' },
        { start: 1, end: 2, text: 'Two.' },
        { start: 2, end: 4, text: 'Three.' },
      ],
    })

    expect(updateSegments).toHaveBeenCalledWith('proj_1', {
      seg_a: { start: 0, end: 1, text: 'One.' },
      seg_b: { start: 1, end: 2, text: 'Two.' },
    })
    // Under a speaker that already exists — a new segment has to name one.
    expect(createSegment).toHaveBeenCalledWith('proj_1', 'sp_1', {
      start: 2,
      end: 4,
      text: 'Three.',
    })
  })

  it('sends the caption’s word, never the one the transcriber misheard', async () => {
    // The real thing, from a live run on `latin-1-toadburger.mp4`. The
    // transcriber heard the clip as two sentences and misheard "toad" as
    // "boaf"; the clip's captions are four lines and say "toad", because
    // somebody corrected them. Numbers are the ones the API and the project
    // document actually carried, clip start included, because the arithmetic
    // that turns timeline seconds into media seconds is the part that would
    // silently put the right words in the wrong places.
    const CLIP_START = 49.78351562499999
    dub.segments = [
      {
        id: 'seg_latin',
        text: 'Hic bufo cum sinapi mirabile sapere posset.',
        speakerId: 'speaker_0',
        start: 0.099,
        end: 4.059,
      },
      {
        id: 'seg_english',
        text: 'This boaf would taste amazing with mustard.',
        speakerId: 'speaker_0',
        start: 5.559,
        end: 7.799,
      },
    ]

    await fixClipAudio({
      ...request,
      duration: 8.08,
      clipStart: CLIP_START,
      language: 'en',
      lines: [
        { start: 49.88251562499999, end: 51.27551562499999, text: 'Hic bufo cum sinapi' },
        { start: 52.023515624999995, end: 54.391515625, text: 'mirabilis saporis esset.' },
        { start: 55.36251562499999, end: 56.477073624999996, text: 'This toad would taste' },
        { start: 56.477073624999996, end: 58.010073625, text: 'amazing with mustard.' },
      ],
    })

    // The two spans the transcriber found are rewritten to the first two
    // captions, on those captions' own marks measured from the head of the clip.
    const [, edits] = updateSegments.mock.calls[0] ?? []
    expect(edits?.seg_latin?.text).toBe('Hic bufo cum sinapi')
    expect(edits?.seg_latin?.start).toBeCloseTo(0.099, 3)
    expect(edits?.seg_latin?.end).toBeCloseTo(1.492, 3)
    expect(edits?.seg_english?.text).toBe('mirabilis saporis esset.')
    expect(edits?.seg_english?.start).toBeCloseTo(2.24, 3)

    // The other two captions have no span to sit on — the transcriber found
    // two and there are four — so they are created. "toad" travels in one of
    // these, which is why a run that dies on the rewrite never sends it at all.
    expect(createSegment.mock.calls.map((call) => call[2].text)).toEqual([
      'This toad would taste',
      'amazing with mustard.',
    ])
    expect(createSegment.mock.calls[0]?.[2].start).toBeCloseTo(5.579, 3)
    // The last caption overhangs the end of the shot, and a segment may not.
    expect(createSegment.mock.calls[1]?.[2].end).toBeCloseTo(8.08, 3)

    // The whole point, stated the blunt way round: nothing the transcriber
    // invented reaches ElevenLabs, in any call, in any field.
    const everythingSent = JSON.stringify([
      updateSegments.mock.calls,
      createSegment.mock.calls,
      deleteSegment.mock.calls,
    ])
    expect(everythingSent).toContain('toad')
    expect(everythingSent).not.toContain('boaf')
    expect(everythingSent).not.toContain('mirabile sapere posset')
  })

  it('empties the spare spans only after the kept ones are rewritten', async () => {
    // A transcript with nothing in it is one dubbing may decide is empty, and
    // refilling it afterwards would pass through that state every time the
    // captions are fewer than the transcriber's spans — which is most runs.
    dub.segments = [
      { id: 'seg_a', text: 'heard one', speakerId: 'sp_1', start: 0, end: 2 },
      { id: 'seg_b', text: 'heard two', speakerId: 'sp_1', start: 2, end: 4 },
    ]
    const order: string[] = []
    updateSegments.mockImplementation(() => {
      order.push('update')
      return Promise.resolve()
    })
    deleteSegment.mockImplementation(() => {
      order.push('delete')
      return Promise.resolve()
    })

    await fixClipAudio(request)

    expect(order).toEqual(['update', 'delete'])
    expect(deleteSegment).toHaveBeenCalledWith('proj_1', 'seg_b')
  })

  it('keeps the audio when only the word timings could not be had', async () => {
    // The audio is made and paid for by then. Losing the karaoke highlight is
    // worth far less than losing the fix.
    alignWords.mockRejectedValue(new Error('alignment unavailable'))

    const result = await fixClipAudio(request)

    expect(result.blob.type).toBe('audio/mpeg')
    expect(result.lines[0]?.words).toEqual([])
  })

  it('tidies the project away even when the dub fails', async () => {
    waitForDub.mockRejectedValue(new Error('out of credit'))
    await expect(fixClipAudio(request)).rejects.toThrow('out of credit')
    expect(deleteDubbingProject).toHaveBeenCalledWith('proj_1')
  })

  it('refuses a clip too long to fit through the proxy, before spending anything', async () => {
    await expect(fixClipAudio({ ...request, duration: 600 })).rejects.toThrow(/has to be under/)
    expect(createDubbingProject).not.toHaveBeenCalled()
  })

  it('refuses an empty script rather than dubbing silence', async () => {
    await expect(
      fixClipAudio({ ...request, lines: [{ start: 0, end: 1, text: '   ' }] }),
    ).rejects.toThrow(/nothing to say/)
    expect(createDubbingProject).not.toHaveBeenCalled()
  })

  it('refuses to guess a language, because a dub only has the one', async () => {
    await expect(fixClipAudio({ ...request, language: '' })).rejects.toThrow(/Pick the language/)
    expect(createDubbingProject).not.toHaveBeenCalled()
  })

  it('reports each stage, and how far through the lines it is', async () => {
    const stages: string[] = []
    await fixClipAudio({
      ...request,
      lines: [
        { start: 0, end: 2, text: 'One.' },
        { start: 2, end: 4, text: 'Two.' },
      ],
      onStage: (stage, done, total) => stages.push(`${stage} ${done}/${total}`),
    })

    expect(stages).toEqual([
      'listening to the clip 0/2',
      'sending it to be dubbed 0/2',
      'finding the lines in it 0/2',
      'putting your words on them 0/2',
      // One tick for the bulk rewrite, however many segments it carried, and
      // then one per segment created afterwards — here the second line, which
      // the transcriber's single span had no room for.
      'putting your words on them 1/2',
      'putting your words on them 2/2',
      'saying them again 0/2',
      'bringing it back 0/2',
      'finding the words in it 0/2',
    ])
  })
})
