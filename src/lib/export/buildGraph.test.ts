import { describe, expect, it } from 'vitest'
import { buildExportPlan, type ExportAudioClip, type ExportClip } from './buildGraph'

const base = { width: 1280, height: 720, fps: 30, outputFile: 'out.mp4' }

const img = (file: string, duration: number): ExportClip => ({
  file,
  kind: 'image',
  inPoint: 0,
  duration,
})

const vid = (file: string, inPoint: number, duration: number): ExportClip => ({
  file,
  kind: 'video',
  inPoint,
  duration,
})

const aud = (
  file: string,
  startTime: number,
  duration: number,
  volume = 1,
  inPoint = 0,
): ExportAudioClip => ({ file, startTime, inPoint, duration, volume })

/** Reads the single -filter_complex value out of an argv array. */
function graphOf(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  expect(index).toBeGreaterThanOrEqual(0)
  return args[index + 1] as string
}

describe('buildExportPlan', () => {
  it('refuses to build an export with no clips', () => {
    expect(() => buildExportPlan({ ...base, clips: [], audio: [] })).toThrow(/at least one clip/i)
  })

  it('loops a still for its authored duration', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 4)], audio: [] })
    expect(args.slice(0, 6)).toEqual(['-loop', '1', '-t', '4', '-i', 'a.png'])
  })

  it('seeks a video to its in-point and takes only the trimmed length', () => {
    const { args } = buildExportPlan({ ...base, clips: [vid('a.mp4', 2.5, 3)], audio: [] })
    // -ss before -i is an input seek, which is fast; -t bounds the trim.
    expect(args.slice(0, 6)).toEqual(['-ss', '2.5', '-t', '3', '-i', 'a.mp4'])
  })

  it('normalises every input to the same size, sar and fps before concatenating', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 2), vid('b.mp4', 0, 3)], audio: [] }).args,
    )
    // Mismatched sar or fps between inputs makes concat fail outright.
    expect(graph).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(graph).toContain('pad=1280:720')
    expect(graph).toContain('setsar=1')
    expect(graph).toContain('fps=30')
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[vout]')
  })

  it('drops audio entirely when there is no voiceover', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [] })
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(graphOf(args)).not.toContain('amix')
  })

  it('delays a single voiceover to its timeline position', () => {
    const voiceovers = [aud('v.mp3', 1.5, 2)]
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 5)], audio: voiceovers })

    // 1.5s in, so 1500ms of delay applied to every channel.
    expect(graphOf(args)).toContain('adelay=1500:all=1')
    expect(args).toContain('-map')
    expect(args).toContain('[aout]')
    expect(args).toContain('-c:a')
  })

  it('mixes several takes without halving their volume', () => {
    const voiceovers = [aud('v1.mp3', 0, 2), aud('v2.mp3', 3, 2)]
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 6)], audio: voiceovers }).args,
    )
    // normalize=1 (the default) would quietly drop every take's level as soon
    // as a second one was added.
    expect(graph).toContain('amix=inputs=2:duration=longest:normalize=0')
  })

  it('numbers audio inputs after all the video inputs', () => {
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [img('a.png', 2), img('b.png', 2)],
        audio: [aud('v.mp3', 0, 1)],
      }).args,
    )
    // Two clips occupy inputs 0 and 1, so the voiceover must be input 2.
    expect(graph).toContain('[2:a]adelay=0:all=1')
  })

  it('holds the last frame when the voiceover runs past the final clip', () => {
    const { args, durationSeconds } = buildExportPlan({
      ...base,
      clips: [img('a.png', 3)],
      audio: [aud('v.mp3', 2, 4)],
    })
    const graph = graphOf(args)

    // Visual runs 3s, audio ends at 6s — pad 3s rather than cutting to black.
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=3')
    expect(durationSeconds).toBe(6)
    expect(args.at(-2)).toBe('6')
  })

  it('does not pad when the visuals already cover the audio', () => {
    const { args, durationSeconds } = buildExportPlan({
      ...base,
      clips: [img('a.png', 10)],
      audio: [aud('v.mp3', 0, 2)],
    })
    expect(graphOf(args)).not.toContain('tpad')
    expect(durationSeconds).toBe(10)
  })

  it('reports the output duration as the longer of picture and sound', () => {
    expect(
      buildExportPlan({ ...base, clips: [img('a.png', 4), img('b.png', 2)], audio: [] })
        .durationSeconds,
    ).toBe(6)
  })

  it('applies a track volume as a gain filter', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 5)], audio: [aud('m.mp3', 0, 5, 0.5)] }).args,
    )
    expect(graph).toContain('volume=0.5')
  })

  it('omits the volume filter at unity, keeping the graph minimal', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 5)], audio: [aud('v.mp3', 0, 5, 1)] }).args,
    )
    expect(graph).not.toContain('volume=')
  })

  it('drops muted and empty clips instead of encoding silence', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [img('a.png', 5)],
      audio: [aud('muted.mp3', 0, 5, 0), aud('empty.mp3', 0, 0, 1)],
    })
    // Nothing audible remains, so the output should have no audio stream.
    expect(args).toContain('-an')
    expect(args).not.toContain('muted.mp3')
    expect(args).not.toContain('empty.mp3')
  })

  it('trims an audio clip at the input, like the video clips', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [img('a.png', 10)],
      audio: [aud('m.mp3', 2, 4, 1, 30)],
    })
    // Start 30s into the music file and take 4s of it.
    const index = args.indexOf('m.mp3')
    expect(args.slice(index - 5, index)).toEqual(['-ss', '30', '-t', '4', '-i'])
  })

  it('mixes several tracks at their own levels', () => {
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [img('a.png', 10)],
        audio: [aud('v1.mp3', 0, 3), aud('v2.mp3', 1, 3), aud('music.mp3', 0, 10, 0.4)],
      }).args,
    )
    // Three layered sources, each placed and levelled independently.
    expect(graph).toContain('amix=inputs=3:duration=longest:normalize=0')
    expect(graph).toContain('[1:a]adelay=0:all=1')
    expect(graph).toContain('[2:a]adelay=1000:all=1')
    expect(graph).toContain('volume=0.4')
  })

  it('keeps overlapping takes as separate inputs rather than merging them', () => {
    // Layering is the whole point: two takes at the same moment must both
    // reach the mixer.
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [img('a.png', 5)],
        audio: [aud('t1.mp3', 1, 2), aud('t2.mp3', 1, 2)],
      }).args,
    )
    expect(graph).toContain('[1:a]adelay=1000:all=1')
    expect(graph).toContain('[2:a]adelay=1000:all=1')
    expect(graph).toContain('amix=inputs=2')
  })

  it('emits web-friendly encoder settings and the output path last', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [] })
    expect(args).toContain('libx264')
    expect(args).toContain('yuv420p') // required for playback in Safari/QuickTime
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('honours a requested quality level', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [img('a.png', 2)],
      audio: [],
      crf: 18,
    })
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
  })

  it('rounds times to milliseconds so floats do not leak into argv', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [vid('a.mp4', 0.1 + 0.2, 1)],
      audio: [],
    })
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(args[1]).toBe('0.3')
  })
})
