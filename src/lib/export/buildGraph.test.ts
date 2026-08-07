import { describe, expect, it } from 'vitest'
import {
  buildExportPlan,
  type ExportAudioClip,
  type ExportClip,
  type ExportOverlayClip,
} from './buildGraph'

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

/** A video clip that was probed and really does carry sound. */
const loud = (file: string, inPoint: number, duration: number, volume = 1): ExportClip => ({
  ...vid(file, inPoint, duration),
  hasAudio: true,
  volume,
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

  it('opens with black when the picture has a lead-in', () => {
    const { args, durationSeconds } = buildExportPlan({
      ...base,
      clips: [img('a.png', 4)],
      audio: [aud('beeps.wav', 0, 3)],
      leadIn: 3,
    })
    const graph = graphOf(args)

    // The count-in plays over the black, so the render is 3s longer than the
    // clips add up to — and the beeps stay at 0, where they were placed.
    expect(graph).toContain('[vcat]tpad=start_mode=add:start_duration=3:color=black[vout]')
    expect(graph).toContain('adelay=0:all=1')
    expect(durationSeconds).toBe(7)
    expect(args.at(-2)).toBe('7')
  })

  it('pushes a clip’s own sound back with its picture', () => {
    // Clip audio is locked to the picture; leaving it at zero while the frames
    // moved would put every filmed clip out of sync by the lead-in.
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [loud('a.mp4', 0, 2), loud('b.mp4', 0, 2)],
        audio: [],
        leadIn: 1.5,
      }).args,
    )
    expect(graph).toContain('[0:a]adelay=1500:all=1')
    expect(graph).toContain('[1:a]adelay=3500:all=1')
  })

  it('pads both ends when a lead-in and an overrunning voiceover meet', () => {
    const { args, durationSeconds } = buildExportPlan({
      ...base,
      clips: [img('a.png', 2)],
      audio: [aud('v.mp3', 0, 9)],
      leadIn: 3,
    })
    const graph = graphOf(args)

    // Picture runs 3s–5s, audio 0s–9s: black in front, last frame held after.
    expect(graph).toContain(
      '[vcat]tpad=start_mode=add:start_duration=3:color=black,tpad=stop_mode=clone:stop_duration=4[vout]',
    )
    expect(durationSeconds).toBe(9)
  })

  it('leaves the graph alone when there is no lead-in', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [], leadIn: 0 }).args,
    )
    expect(graph).not.toContain('tpad')
    expect(graph).toContain('concat=n=1:v=1:a=0[vout]')
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

  it('mixes a video clip’s own sound in at its place on the timeline', () => {
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [img('a.png', 2), loud('b.mp4', 0, 3)],
        audio: [],
      }).args,
    )
    // The still occupies the first two seconds, so the clip's audio belongs
    // 2000ms in — the same input index as its picture.
    expect(graph).toContain('[1:a]adelay=2000:all=1')
    expect(graph).toContain('[c1]anull[aout]')
  })

  it('mixes clip sound together with the audio tracks', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [loud('a.mp4', 0, 4)],
      audio: [aud('v.mp3', 1, 2)],
    })
    const graph = graphOf(args)
    expect(graph).toContain('[0:a]adelay=0:all=1')
    expect(graph).toContain('[1:a]adelay=1000:all=1')
    expect(graph).toContain('amix=inputs=2:duration=longest:normalize=0')
    expect(args).toContain('-c:a')
  })

  it('leaves a clip out of the mix when the file has no audio stream', () => {
    // Naming [0:a] on an input with no audio does not degrade — it fails the
    // whole render — so an unprobed or silent clip must never be referenced.
    const { args } = buildExportPlan({ ...base, clips: [vid('a.mp4', 0, 4)], audio: [] })
    expect(graphOf(args)).not.toContain(':a]')
    expect(args).toContain('-an')
  })

  it('leaves out a clip the user silenced, even though it has sound', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [loud('a.mp4', 0, 4, 0)],
      audio: [],
    })
    expect(graphOf(args)).not.toContain('[0:a]')
    expect(args).toContain('-an')
  })

  it('applies a clip volume as a gain filter', () => {
    const graph = graphOf(
      buildExportPlan({ ...base, clips: [loud('a.mp4', 0, 4, 0.3)], audio: [] }).args,
    )
    expect(graph).toContain('[0:a]adelay=0:all=1,volume=0.3,aresample=48000[c0]')
  })

  it('never takes audio from a still, whatever it claims', () => {
    const { args } = buildExportPlan({
      ...base,
      clips: [{ ...img('a.png', 3), hasAudio: true }],
      audio: [],
    })
    // An image input is `-loop 1`; there is no audio stream to name.
    expect(args).toContain('-an')
  })

  it('places every clip’s sound after the trims that precede it', () => {
    const graph = graphOf(
      buildExportPlan({
        ...base,
        clips: [loud('a.mp4', 0, 1.5), loud('b.mp4', 4, 2), loud('c.mp4', 0, 1)],
        audio: [],
      }).args,
    )
    // Positions follow the trimmed lengths, not the source durations.
    expect(graph).toContain('[0:a]adelay=0:all=1')
    expect(graph).toContain('[1:a]adelay=1500:all=1')
    expect(graph).toContain('[2:a]adelay=3500:all=1')
    expect(graph).toContain('amix=inputs=3')
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

  describe('captions', () => {
    const captions = { file: 'captions.ass', fontsDir: '/fonts' }

    it('leaves the graph untouched when there are none', () => {
      const graph = graphOf(buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [] }).args)
      expect(graph).not.toContain('ass=')
    })

    it('burns them in, naming the fonts directory libass needs', () => {
      const graph = graphOf(
        buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [], captions }).args,
      )
      expect(graph).toContain('[vcat]ass=filename=captions.ass:fontsdir=/fonts[vout]')
    })

    it('burns them in after the lead-in, so cue times mean timeline times', () => {
      const graph = graphOf(
        buildExportPlan({ ...base, clips: [img('a.png', 2)], audio: [], leadIn: 3, captions }).args,
      )
      // In this order: the black goes on first, and the captions are laid over
      // the padded stream, whose clock is the timeline's. Burning them in first
      // would date every cue from the first frame of picture instead.
      expect(graph).toContain('[vcat]tpad=start_mode=add:start_duration=3:color=black[vpad]')
      expect(graph).toContain('[vpad]ass=filename=captions.ass:fontsdir=/fonts[vout]')
    })

    it('still holds the last frame for audio that outruns the picture', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 2)],
          audio: [aud('music.mp3', 0, 8)],
          captions,
        }).args,
      )
      expect(graph).toContain('[vcat]tpad=stop_mode=clone:stop_duration=6[vpad]')
      expect(graph).toContain('[vpad]ass=filename=captions.ass')
    })
  })

  /**
   * Layers over the picture.
   *
   * The two things worth pinning down are when a layer is on screen and what is
   * under it, because both are invisible in the argv until they are wrong: an
   * ungated overlay sticks for the rest of the film, and one applied before the
   * lead-in padding lands early by exactly the length of the black.
   */
  describe('video layers', () => {
    const over = (
      file: string,
      startTime: number,
      duration: number,
      extra: Partial<ExportOverlayClip> = {},
    ): ExportOverlayClip => ({ file, kind: 'video', inPoint: 0, startTime, duration, ...extra })

    it('lays one over the picture for its own stretch of timeline only', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [over('b.mp4', 2, 3)],
        }).args,
      )

      expect(graph).toContain('setpts=PTS-STARTPTS+2/TB[ov0]')
      expect(graph).toContain(
        "[vcat][ov0]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,2,5)'[vout]",
      )
    })

    it('fits the layer inside the frame instead of padding it', () => {
      // A padded layer is a full frame of black with the picture inside it, and
      // a full frame of black over the picture is a replacement, not an overlay.
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [over('b.mp4', 0, 2)],
        }).args,
      )

      expect(graph).toContain('[1:v]scale=1280:720:force_original_aspect_ratio=decrease')
      expect(graph.split('[ov0]')[0]).not.toContain(
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[ov0',
      )
    })

    it('lays them on in track order, each over the last', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [over('b.mp4', 0, 2), over('c.mp4', 0, 2)],
        }).args,
      )

      expect(graph).toContain('[vcat][ov0]overlay=')
      expect(graph).toContain('[vov0][ov1]overlay=')
    })

    it('goes on after the lead-in, so a layer lands when it was placed', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          leadIn: 3,
          overlays: [over('b.mp4', 1, 2)],
        }).args,
      )

      // Over the padded stream: the layer sits at one second, which is inside
      // the black, and not at four.
      expect(graph).toContain('[vpad][ov0]overlay=')
      expect(graph).toContain("enable='between(t,1,3)'")
    })

    it('goes on under the captions, which belong on top of everything', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [over('b.mp4', 0, 2)],
          captions: { file: 'captions.ass', fontsDir: '/fonts' },
        }).args,
      )

      expect(graph).toContain('[vcat][ov0]overlay=')
      expect(graph).toContain('[vov0]ass=filename=captions.ass:fontsdir=/fonts[vout]')
    })

    it('blends a lane that is not fully opaque', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [over('b.mp4', 0, 2, { opacity: 0.4 })],
        }).args,
      )

      expect(graph).toContain('format=yuva420p,colorchannelmixer=aa=0.4')
    })

    it('leaves out a layer that would be invisible anyway', () => {
      // A hidden lane arrives as opacity 0. Encoding it would cost an input and
      // a filter chain to change not one pixel.
      const plan = buildExportPlan({
        ...base,
        clips: [img('a.png', 10)],
        audio: [],
        overlays: [over('b.mp4', 0, 2, { opacity: 0 }), over('c.mp4', 0, 0)],
      })

      expect(graphOf(plan.args)).not.toContain('overlay=')
      expect(plan.args).not.toContain('b.mp4')
    })

    it('loops a still for as long as it is held', () => {
      const args = buildExportPlan({
        ...base,
        clips: [img('a.png', 10)],
        audio: [],
        overlays: [{ file: 'logo.png', kind: 'image', inPoint: 0, startTime: 1, duration: 4 }],
      }).args

      expect(args.join(' ')).toContain('-loop 1 -t 4 -i logo.png')
    })

    it('holds the last frame of picture under a layer that outruns it', () => {
      // Otherwise the picture ends and the layer plays on over black, which is
      // not what a layer laid over the end of a shot is meant to look like.
      const plan = buildExportPlan({
        ...base,
        clips: [img('a.png', 4)],
        audio: [],
        overlays: [over('b.mp4', 3, 5)],
      })

      expect(graphOf(plan.args)).toContain('tpad=stop_mode=clone:stop_duration=4')
      expect(plan.durationSeconds).toBe(8)
    })

    it('mixes a layer’s own sound, at its absolute start time', () => {
      // The preview plays it, so the export has to. And unlike a picture clip's
      // sound it is already absolute, so no lead-in is added to it.
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          leadIn: 2,
          overlays: [over('b.mp4', 3, 2, { hasAudio: true, volume: 0.5 })],
        }).args,
      )

      expect(graph).toContain('[1:a]adelay=3000:all=1,volume=0.5,aresample=48000[o0]')
    })

    it('leaves a silent or muted layer out of the mix', () => {
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10)],
          audio: [],
          overlays: [
            over('b.mp4', 0, 2, { hasAudio: true, volume: 0 }),
            over('c.mp4', 0, 2, { hasAudio: false }),
            { file: 'd.png', kind: 'image', inPoint: 0, startTime: 0, duration: 2 },
          ],
        }).args,
      )

      expect(graph).not.toContain('[o0]')
      expect(graph).not.toContain('[o1]')
      expect(graph).not.toContain('[o2]')
    })

    it('numbers the audio inputs after the layers, not through them', () => {
      // The one thing that silently ruins an export: an off-by-one here maps a
      // filter onto the wrong file, and ffmpeg is happy to render it.
      const graph = graphOf(
        buildExportPlan({
          ...base,
          clips: [img('a.png', 10), img('b.png', 2)],
          audio: [aud('music.mp3', 0, 5)],
          overlays: [over('c.mp4', 0, 2)],
        }).args,
      )

      expect(graph).toContain('[2:v]scale=')
      expect(graph).toContain('[3:a]adelay=0:all=1')
    })
  })
})
