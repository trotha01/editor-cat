import { describe, expect, it } from 'vitest'
import { captionTargets, speechSources } from './captionSources'
import type { Asset, AudioClip, AudioTrack, AudioTrackKind, Clip, Project } from './types'

const asset = (id: string, kind: Asset['kind'], duration = 10): Asset => ({
  id,
  kind,
  blobKey: `blob-${id}`,
  mimeType: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/webm' : 'image/png',
  name: `${id}.file`,
  duration,
  createdAt: 0,
})

const track = (id: string, kind: AudioTrackKind, muted = false): AudioTrack => ({
  id,
  kind,
  name: id,
  muted,
  volume: 1,
})

const audioClip = (id: string, trackId: string, extra: Partial<AudioClip> = {}): AudioClip => ({
  id,
  trackId,
  assetId: `asset-${id}`,
  useConverted: false,
  startTime: 0,
  inPoint: 0,
  duration: 5,
  ...extra,
})

const clip = (id: string, assetId: string, extra: Partial<Clip> = {}): Clip => ({
  id,
  assetId,
  inPoint: 0,
  outPoint: 4,
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

describe('speechSources', () => {
  it('takes the voice tracks and leaves the music and the beeps alone', () => {
    const sources = speechSources(
      project({
        audioTracks: [
          track('t-voice', 'voice'),
          track('t-music', 'music'),
          track('t-cue', 'countdown'),
        ],
        audioClips: [audioClip('a', 't-voice'), audioClip('b', 't-music'), audioClip('c', 't-cue')],
      }),
      [asset('asset-a', 'audio'), asset('asset-b', 'audio'), asset('asset-c', 'audio')],
    )
    expect(sources.map((source) => source.id)).toEqual(['a'])
  })

  it('skips a muted voice track, because its words are not in the finished video', () => {
    const sources = speechSources(
      project({
        audioTracks: [track('t-voice', 'voice', true)],
        audioClips: [audioClip('a', 't-voice')],
      }),
      [asset('asset-a', 'audio')],
    )
    expect(sources).toEqual([])
  })

  it('skips a voice track turned all the way down, which is just as silent', () => {
    const sources = speechSources(
      project({
        audioTracks: [{ ...track('t-voice', 'voice'), volume: 0 }],
        audioClips: [audioClip('a', 't-voice')],
      }),
      [asset('asset-a', 'audio')],
    )
    expect(sources).toEqual([])
  })

  it('transcribes whichever version of a converted take is set to play', () => {
    const [source] = speechSources(
      project({
        audioTracks: [track('t-voice', 'voice')],
        audioClips: [audioClip('a', 't-voice', { convertedAssetId: 'conv', useConverted: true })],
      }),
      [asset('asset-a', 'audio'), asset('conv', 'audio')],
    )
    expect(source?.assetId).toBe('conv')
  })

  it('includes the sound a video clip carries, positioned where the clip sits', () => {
    const [, second] = speechSources(
      project({
        leadIn: 2,
        clips: [clip('c1', 'v1'), clip('c2', 'v2', { inPoint: 1, outPoint: 5 })],
      }),
      [asset('v1', 'video'), asset('v2', 'video')],
    )
    expect(second).toMatchObject({ id: 'c2', assetId: 'v2', startTime: 6, inPoint: 1, duration: 4 })
  })

  it('skips stills and clips you silenced', () => {
    const sources = speechSources(
      project({
        clips: [
          clip('c1', 'i1'),
          clip('c2', 'v1', { muted: true }),
          clip('c3', 'v2', { volume: 0 }),
        ],
      }),
      [asset('i1', 'image'), asset('v1', 'video'), asset('v2', 'video')],
    )
    expect(sources).toEqual([])
  })

  it('returns everything in timeline order, so progress reads sensibly', () => {
    const sources = speechSources(
      project({
        audioTracks: [track('t-voice', 'voice')],
        audioClips: [audioClip('late', 't-voice', { startTime: 30 })],
        clips: [clip('early', 'v1')],
      }),
      [asset('asset-late', 'audio'), asset('v1', 'video')],
    )
    expect(sources.map((source) => source.id)).toEqual(['early', 'late'])
  })
})

describe('captionTargets', () => {
  const captioned = (clipId: string, label: string) => ({
    id: `cue-${clipId}`,
    trackId: 'ctrack',
    start: 0,
    end: 1,
    words: [{ id: 'w1', text: 'hi', start: 0, end: 0.4 }],
    source: { id: clipId, label },
  })

  it('offers every clip with speech in it, keyed by the clip on the timeline', () => {
    const targets = captionTargets(
      project({
        audioTracks: [track('t-voice', 'voice')],
        audioClips: [audioClip('take', 't-voice')],
        clips: [clip('shot', 'v1')],
      }),
      [asset('asset-take', 'audio'), asset('v1', 'video')],
    )
    expect([...targets.keys()].sort()).toEqual(['shot', 'take'])
  })

  it('counts the captions each clip already answers for, which is what makes it a redo', () => {
    const targets = captionTargets(
      project({
        clips: [clip('shot', 'v1'), clip('other', 'v2')],
        captionCues: [
          captioned('shot', 'v1.file'),
          { ...captioned('shot', 'v1.file'), id: 'cue-2' },
          captioned('other', 'v2.file'),
        ],
      }),
      [asset('v1', 'video'), asset('v2', 'video')],
    )
    expect(targets.get('shot')?.captions).toBe(2)
    expect(targets.get('other')?.captions).toBe(1)
  })

  it('leaves out what cannot be transcribed, which is the menu\u2019s answer too', () => {
    const targets = captionTargets(
      project({
        audioTracks: [track('t-music', 'music')],
        audioClips: [audioClip('bed', 't-music')],
        clips: [clip('still', 'i1'), clip('silenced', 'v1', { muted: true })],
      }),
      [asset('asset-bed', 'audio'), asset('i1', 'image'), asset('v1', 'video')],
    )
    expect([...targets.keys()]).toEqual([])
  })

  it('reports a clip that has never been captioned as having none', () => {
    const targets = captionTargets(project({ clips: [clip('shot', 'v1')] }), [asset('v1', 'video')])
    expect(targets.get('shot')).toMatchObject({ captions: 0, source: { id: 'shot' } })
  })
})
