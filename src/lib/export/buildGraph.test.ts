import { describe, expect, it } from 'vitest'
import { buildExportPlan, type ExportClip, type ExportVoiceover } from './buildGraph'

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

/** Reads the single -filter_complex value out of an argv array. */
function graphOf(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  expect(index).toBeGreaterThanOrEqual(0)
  return args[index + 1] as string
}

describe('buildExportPlan', () => {
  it('refuses to build an export with no clips', () => {
    expect(() => buildExportPlan({ ...base, clips: [], voiceovers: [] })).toThrow(
      /at least one clip/i,
    )
  })

  it('loops a still for its authored duration', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 4)], voiceovers: [] })
    expect(args.slice(0, 6)).toEqual(['-loop', '1', '-t', '4', '-i', 'a.png'])
  })

  it('seeks a video to its in-point and takes only the trimmed length', () => {
    const { args } = buildExportPlan({ ...base, clips: [vid('a.mp4', 2.5, 3)], voiceovers: [] })
    // -ss before -i is an input seek, which is fast; -t bounds the trim.
    expect(args.slice(0, 6)).toEqual(['-ss', '2.5', '-t', '3', '-i', 'a.mp4'])
  })

  it('normalises every input to the same size, sar and fps before concatenating', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 2), vid('b.mp4', 0, 3)], voiceovers: [] })
        .args,
    )
    // Mismatched sar or fps between inputs makes concat fail outright.
    expect(graph).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(graph).toContain('pad=1280:720')
    expect(graph).toContain('setsar=1')
    expect(graph).toContain('fps=30')
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[vout]')
  })

  it('drops audio entirely when there is no voiceover', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 2)], voiceovers: [] })
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(graphOf(args)).not.toContain('amix')
  })

  it('delays a single voiceover to its timeline position', () => {
    const voiceovers: ExportVoiceover[] = [{ file: 'v.mp3', startTime: 1.5, duration: 2 }]
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 5)], voiceovers })

    // 1.5s in, so 1500ms of delay applied to every channel.
    expect(graphOf(args)).toContain('adelay=1500:all=1')
    expect(args).toContain('-map')
    expect(args).toContain('[aout]')
    expect(args).toContain('-c:a')
  })

  it('mixes several takes without halving their volume', () => {
    const voiceovers: ExportVoiceover[] = [
      { file: 'v1.mp3', startTime: 0, duration: 2 },
      { file: 'v2.mp3', startTime: 3, duration: 2 },
    ]
    const graph = graphOf(buildExportPlan({ ...base, clips: [img('a.png', 6)], voiceovers }).args)
    // normalize=1 (the default) would quietly drop every take's level as soon
    // as a second one was added.
    expect(graph).toContain('amix=inputs=2:duration=longest:normalize=0')
  })

  it('numbers audio inputs after all the video inputs', () => {
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [img('a.png', 2), img('b.png', 2)],
        voiceovers: [{ file: 'v.mp3', startTime: 0, duration: 1 }],
      }).args,
    )
    // Two clips occupy inputs 0 and 1, so the voiceover must be input 2.
    expect(graph).toContain('[2:a]adelay=0:all=1')
  })

  it('holds the last frame when the voiceover runs past the final clip', () => {
    const { args, durationSeconds } = buildExportPlan({
      ...base,
      clips: [img('a.png', 3)],
      voiceovers: [{ file: 'v.mp3', startTime: 2, duration: 4 }],
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
      voiceovers: [{ file: 'v.mp3', startTime: 0, duration: 2 }],
    })
    expect(graphOf(args)).not.toContain('tpad')
    expect(durationSeconds).toBe(10)
  })

  it('reports the output duration as the longer of picture and sound', () => {
    expect(
      buildExportPlan({ ...base, clips: [img('a.png', 4), img('b.png', 2)], voiceovers: [] })
        .durationSeconds,
    ).toBe(6)
  })

  it('emits web-friendly encoder settings and the output path last', () => {
    const { args } = buildExportPlan({ ...base, clips: [img('a.png', 2)], voiceovers: [] })
    expect(args).toContain('libx264')
    expect(args).toContain('yuv420p') // required for playback in Safari/QuickTime
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('honours a requested quality level', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [img('a.png', 2)],
      voiceovers: [],
      crf: 18,
    })
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
  })

  it('rounds times to milliseconds so floats do not leak into argv', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [vid('a.mp4', 0.1 + 0.2, 1)],
      voiceovers: [],
    })
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(args[1]).toBe('0.3')
  })
})
