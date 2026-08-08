/**
 * Builds the ffmpeg command line for an export.
 *
 * This is deliberately a pure function over plain data: given visual clips and
 * audio clips it returns argv, with no wasm, no filesystem and no browser
 * involved. Export bugs are almost always filtergraph bugs, and this way they
 * can be caught by a unit test asserting on the arguments instead of by
 * rendering a video and squinting at it.
 *
 * Two things feed the mixer, and both are placed the same way — delayed to
 * where they belong on the timeline, scaled, and summed. The audio tracks are
 * one; the sound a video clip carries itself is the other, which keeps a
 * filmed clip's own audio locked to its picture without the user having to
 * lift it onto a track. Muted tracks are expected to have been dropped by the
 * caller — silence is cheaper to produce by not encoding a stream than by
 * encoding one at zero gain.
 *
 * `hasAudio` must be the truth about the file rather than an assumption:
 * referencing `[n:a]` on an input with no audio stream fails the whole render,
 * so the caller probes each file first (see probe.ts).
 *
 * Transitions are the one thing that changes how the picture is assembled:
 * without them the clips are concatenated in a single filter, and with them they
 * are joined a pair at a time by `xfade`, which is the only way to say where
 * each blend begins. Nothing else in the graph moves — the padding, the layers
 * and the captions all still go on afterwards, in that order.
 */

/**
 * How a clip comes in from the one before it.
 *
 * Named by ffmpeg's own `xfade` transition rather than by anything this app
 * calls it, so this file stays what it is: plain data in, argv out, with no
 * opinion about what a "dissolve" is. The mapping lives at the edge, in
 * render.ts.
 */
export interface ExportTransition {
  /** An `xfade` transition name, e.g. `fade`. */
  name: string
  /** Seconds the two clips are on screen together. */
  duration: number
}

export interface ExportClip {
  /** Filename as written into the ffmpeg virtual filesystem. */
  file: string
  kind: 'image' | 'video'
  /** Seconds into the source. Ignored for images. */
  inPoint: number
  /** Seconds of output this clip contributes. */
  duration: number
  /**
   * The transition into this clip. Absent is a straight cut, and absent on the
   * first clip whatever it says — there is nothing in front of it to blend from.
   *
   * It must be no longer than either neighbour, and a clip between two of them
   * must be longer than both together. The caller fits them (`fitTransitions`);
   * an overlap the material cannot cover fails the render outright.
   */
  transition?: ExportTransition
  /** Whether this file really carries an audio stream. Probed, never guessed. */
  hasAudio?: boolean
  /** Gain for that audio. Absent is unity; 0 keeps it out of the mix. */
  volume?: number
}

export interface ExportAudioClip {
  file: string
  /** Seconds from the start of the timeline. */
  startTime: number
  /** Seconds into the source to start from. */
  inPoint: number
  duration: number
  /** Track gain. 1 is unity; the filter is omitted at unity. */
  volume: number
}

/**
 * A clip layered over the picture rather than laid end to end with it.
 *
 * `startTime` is absolute timeline seconds and is *not* shifted by the lead-in,
 * exactly like an audio clip's. A layer placed at four seconds belongs at four
 * seconds whatever black precedes the picture, which is what lets one land on
 * the lead-in at all.
 */
export interface ExportOverlayClip {
  file: string
  kind: 'image' | 'video'
  /** Seconds into the source. Ignored for images. */
  inPoint: number
  duration: number
  /** Where it starts on the timeline, in absolute seconds. */
  startTime: number
  /** 0 to 1. Absent is opaque. */
  opacity?: number
  /** Whether this file really carries an audio stream. Probed, never guessed. */
  hasAudio?: boolean
  /** Gain for that audio. Absent is unity; 0 keeps it out of the mix. */
  volume?: number
}

export interface ExportSpec {
  clips: readonly ExportClip[]
  audio: readonly ExportAudioClip[]
  /** Layers over the picture, bottom of the stack first. */
  overlays?: readonly ExportOverlayClip[]
  width: number
  height: number
  fps: number
  outputFile: string
  /**
   * Seconds of black before the first clip. The picture and the sound it
   * carries both move by it; the audio tracks do not, since their start times
   * are already absolute — which is the whole point, as it is what lets a
   * count-in play before anything is on screen.
   */
  leadIn?: number
  /**
   * An ASS subtitle file to burn in, and the directory holding the fonts it
   * names. Both are filenames inside ffmpeg's own filesystem.
   *
   * `fontsDir` is not optional in practice: ffmpeg.wasm has no system fonts, and
   * libass asked to render without any draws nothing at all while still exiting
   * zero — an export that silently loses its captions. See
   * scripts/copy-caption-font.mjs.
   */
  captions?: { file: string; fontsDir: string }
  /** 18 is visually lossless, 28 is small. 23 is a good middle. */
  crf?: number
  preset?: string
}

export interface ExportPlan {
  args: string[]
  /** Expected output length in seconds, used to drive the progress bar. */
  durationSeconds: number
}

/** Seconds rounded to millisecond precision, avoiding float noise in argv. */
function sec(value: number): string {
  return (Math.round(value * 1000) / 1000).toString()
}

/** Gain to three decimals — finer than anyone can hear, and keeps argv tidy. */
function roundGain(value: number): string {
  return (Math.round(value * 1000) / 1000).toString()
}

/**
 * A crossfade over a clip's own sound, for a clip that is dissolving into or
 * out of its neighbour.
 *
 * Without it both clips play flat out through the overlap and the two are
 * simply summed, which is a doubling anyone can hear — and which the preview
 * does not do, so the export would no longer be what was played back. Linear on
 * both sides, matching `afade`'s default curve and the preview's own arithmetic.
 */
interface AudioFades {
  /** Seconds fading up from the clip's first frame. */
  in: number
  /** Seconds fading down into the clip's last frame. */
  out: number
  /** The clip's own length, which is where the fade out has to be measured from. */
  length: number
}

/**
 * The chain that puts one source where it belongs: faded at whichever ends
 * dissolve, delayed to its start on the timeline, levelled, and resampled so
 * everything reaching the mixer agrees on a rate.
 *
 * The fades come first because they are measured from the clip's own start, and
 * `adelay` is what moves that start onto the timeline.
 */
function placeAudio(startTime: number, volume: number, fades?: AudioFades): string {
  const delayMs = Math.max(0, Math.round(startTime * 1000))
  const stages: string[] = []
  if (fades && fades.in > 0) stages.push(`afade=t=in:st=0:d=${sec(fades.in)}`)
  if (fades && fades.out > 0) {
    stages.push(`afade=t=out:st=${sec(Math.max(0, fades.length - fades.out))}:d=${sec(fades.out)}`)
  }
  // all=1 applies the delay to every channel, so it works for mono and stereo
  // sources alike without knowing the layout up front.
  stages.push(`adelay=${delayMs}:all=1`)
  // Skip the filter at unity so an untouched mix stays byte-identical to what
  // it produced before volumes existed.
  if (volume !== 1) stages.push(`volume=${roundGain(volume)}`)
  stages.push('aresample=48000')
  return stages.join(',')
}

/** The overlap into a clip, which is nothing at all for the first one. */
function overlapInto(clips: readonly ExportClip[], index: number): number {
  if (index <= 0) return 0
  return Math.max(0, clips[index]?.transition?.duration ?? 0)
}

/**
 * Pairs each clip with where it starts on the timeline and which input it is.
 * Clips sit end to end with no gaps, so the start is the lead-in plus the sum
 * of what precedes — pulled back by any transition, which is time two clips
 * spend on screen together rather than one after the other.
 */
function withStarts(
  clips: readonly ExportClip[],
  leadIn = 0,
): { clip: ExportClip; input: number; start: number }[] {
  let cursor = Math.max(0, leadIn)
  return clips.map((clip, input) => {
    const start = Math.max(0, cursor - overlapInto(clips, input))
    cursor = start + Math.max(0, clip.duration)
    return { clip, input, start }
  })
}

export function totalVisualDuration(clips: readonly ExportClip[]): number {
  const laid = withStarts(clips)
  const last = laid[laid.length - 1]
  return last ? last.start + Math.max(0, last.clip.duration) : 0
}

export function totalAudioEnd(audio: readonly ExportAudioClip[]): number {
  return audio.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
}

export function totalOverlayEnd(overlays: readonly ExportOverlayClip[]): number {
  return overlays.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
}

/**
 * The chain that turns one source into something that can be laid over the
 * picture: fitted inside the frame, at the output rate, and shifted to the
 * moment it belongs at.
 *
 * Fitted rather than padded. Padding would make the layer a full frame of black
 * with the picture letterboxed inside it, and a full frame of black laid over
 * the picture is not an overlay — it is a replacement. Scaling to fit and
 * centring at the overlay step keeps the bars out of it entirely.
 *
 * `setpts` is written with `-STARTPTS` rather than trusting the input seek to
 * have normalised the timestamps, so a layer lands where it was placed rather
 * than wherever its source happened to be cut from.
 */
function placeOverlay(clip: ExportOverlayClip, width: number, height: number, fps: number): string {
  const opacity = clip.opacity ?? 1
  const stages = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    'setsar=1',
    `fps=${fps}`,
  ]
  if (opacity < 1) {
    // yuva, because blending needs somewhere to put the alpha this writes.
    stages.push('format=yuva420p', `colorchannelmixer=aa=${roundGain(opacity)}`)
  } else {
    stages.push('format=yuv420p')
  }
  stages.push(`setpts=PTS-STARTPTS+${sec(clip.startTime)}/TB`)
  return stages.join(',')
}

export function buildExportPlan(spec: ExportSpec): ExportPlan {
  const { clips, width, height, fps, outputFile } = spec

  if (clips.length === 0) {
    throw new Error('Add at least one clip to the timeline before exporting.')
  }

  // A silent clip contributes nothing but an input and a filter chain, and a
  // zero-length one would produce an empty stream that amix chokes on.
  const audio = spec.audio.filter((clip) => clip.volume > 0 && clip.duration > 0)

  // A layer on a hidden lane, or one with no length, contributes nothing but an
  // input and a filter chain — and a zero-length one would make an empty stream
  // that overlay has nothing to do with.
  const overlays = (spec.overlays ?? []).filter(
    (clip) => clip.duration > 0 && (clip.opacity ?? 1) > 0,
  )

  const leadIn = Math.max(0, spec.leadIn ?? 0)
  const visualEnd = leadIn + totalVisualDuration(clips)
  const audioEnd = totalAudioEnd(audio)
  const overlayEnd = totalOverlayEnd(overlays)
  // What has to still be on screen after the picture track runs out. Layers
  // count here as well as sound: a layer held past the last clip needs
  // something under it, and black would be the picture ending early.
  const contentEnd = Math.max(audioEnd, overlayEnd)
  const outputDuration = Math.max(visualEnd, contentEnd)

  const args: string[] = []

  // --- Inputs ------------------------------------------------------------
  for (const clip of clips) {
    if (clip.kind === 'image') {
      args.push('-loop', '1', '-t', sec(clip.duration), '-i', clip.file)
    } else {
      // Input-level seek: much faster than trimming inside the filtergraph,
      // and ffmpeg makes it accurate by decoding from the preceding keyframe.
      args.push('-ss', sec(clip.inPoint), '-t', sec(clip.duration), '-i', clip.file)
    }
  }

  const overlayInputOffset = clips.length
  for (const clip of overlays) {
    if (clip.kind === 'image') {
      args.push('-loop', '1', '-t', sec(clip.duration), '-i', clip.file)
    } else {
      args.push('-ss', sec(clip.inPoint), '-t', sec(clip.duration), '-i', clip.file)
    }
  }

  const audioInputOffset = clips.length + overlays.length
  for (const clip of audio) {
    // Trim at the input like the video clips, so the filtergraph only has to
    // place and mix rather than also cut.
    args.push('-ss', sec(clip.inPoint), '-t', sec(clip.duration), '-i', clip.file)
  }

  // --- Video graph -------------------------------------------------------
  const chains: string[] = []
  const normalized: string[] = []

  // Whether anything blends, which decides how the clips are joined below.
  const blending = clips.some((_, index) => overlapInto(clips, index) > 0)

  clips.forEach((_, index) => {
    const label = `v${index}`
    chains.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},` +
        `format=yuv420p` +
        // xfade reads the offset off the input's own timestamps, so they have to
        // start at zero. The input seek normally sees to that; saying so costs
        // nothing and turns "the dissolve happened somewhere else entirely" into
        // a bug that cannot occur. Left off when nothing blends, so an export
        // without transitions is the graph it always was.
        (blending ? ',setpts=PTS-STARTPTS' : '') +
        `[${label}]`,
    )
    normalized.push(`[${label}]`)
  })

  // The picture is built up in stages, each taking the last one's label:
  // concatenated, padded to the timeline's own clock, layered on, then
  // captioned. The order is the whole point — see each step below.
  //
  // Counting the stages up front lets whichever turns out to be last write
  // [vout] itself, rather than every export ending with a relabelling filter
  // that exists only because the graph was built without looking ahead.
  let pending = leadIn > 0 || contentEnd > visualEnd + 0.01 ? 1 : 0
  pending += overlays.length + (spec.captions ? 1 : 0)
  const nextStage = (label: string): string => {
    pending -= 1
    return pending === 0 ? '[vout]' : label
  }

  let stage = pending === 0 ? '[vout]' : '[vcat]'
  if (!blending) {
    chains.push(`${normalized.join('')}concat=n=${clips.length}:v=1:a=0${stage}`)
  } else {
    // With a transition anywhere, the clips are joined a pair at a time instead:
    // `xfade` takes exactly two inputs and has to know how far into the picture
    // so far the blend begins, which is only knowable one join at a time.
    //
    // The offset is the accumulated length *minus* the overlap, which is the
    // same number `layoutClips` arrives at for where the incoming clip starts —
    // the two have to agree or the preview is showing a different edit.
    let current = normalized[0] as string
    let elapsed = Math.max(0, clips[0]?.duration ?? 0)
    for (let index = 1; index < clips.length; index += 1) {
      const overlap = overlapInto(clips, index)
      const last = index === clips.length - 1
      const out = last ? stage : `[vj${index}]`
      const length = Math.max(0, clips[index]?.duration ?? 0)
      if (overlap > 0) {
        const name = clips[index]?.transition?.name ?? 'fade'
        chains.push(
          `${current}${normalized[index]}xfade=transition=${name}:` +
            `duration=${sec(overlap)}:offset=${sec(Math.max(0, elapsed - overlap))}${out}`,
        )
      } else {
        // A straight cut between two clips that are otherwise part of a blended
        // run. Still a concat, just of two rather than of all of them.
        chains.push(`${current}${normalized[index]}concat=n=2:v=1:a=0${out}`)
      }
      elapsed += length - overlap
      current = out
    }
  }

  // Padding at either end, both done with tpad on the concatenated picture:
  // black in front for the lead-in, and the last frame held at the back when
  // sound or a layer outlasts the picture.
  const padding: string[] = []
  if (leadIn > 0) {
    padding.push(`tpad=start_mode=add:start_duration=${sec(leadIn)}:color=black`)
  }
  if (contentEnd > visualEnd + 0.01) {
    // Something runs past the last clip, so hold its final frame rather than
    // cutting to black mid-sentence — or out from under a layer still on screen.
    padding.push(`tpad=stop_mode=clone:stop_duration=${sec(contentEnd - visualEnd)}`)
  }
  if (padding.length > 0) {
    const out = nextStage('[vpad]')
    chains.push(`${stage}${padding.join(',')}${out}`)
    stage = out
  }

  // Layers, after the padding for the same reason the captions are: a layer's
  // start time is absolute timeline seconds, and it is the padding that makes
  // the stream's clock agree with the timeline. Applied bottom of the stack
  // first, each over the result of the last, which is what makes the track
  // order the stacking order.
  overlays.forEach((clip, index) => {
    const input = overlayInputOffset + index
    chains.push(`[${input}:v]${placeOverlay(clip, width, height, fps)}[ov${index}]`)
    const out = nextStage(`[vov${index}]`)
    // `enable` gates it to its own stretch of timeline; `eof_action=pass` keeps
    // the picture flowing once the layer has run out rather than ending the
    // output with it.
    const until = sec(clip.startTime + clip.duration)
    chains.push(
      `${stage}[ov${index}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:` +
        `enable='between(t,${sec(clip.startTime)},${until})'${out}`,
    )
    stage = out
  })

  // Captions go on last of all: they belong on top of everything, including a
  // layer, and like the layers they are dated from the timeline rather than
  // from the first frame of picture. Burning them in before the lead-in padding
  // would put every caption late by the length of it — and lose outright any
  // caption written over it.
  if (spec.captions) {
    chains.push(
      `${stage}ass=filename=${spec.captions.file}:fontsdir=${spec.captions.fontsDir}${nextStage('[vass]')}`,
    )
  }

  // --- Audio graph -------------------------------------------------------
  const placed: string[] = []

  // A clip's own sound needs no trimming of its own: the input-level -ss/-t
  // that cut the picture cut its audio to exactly the same stretch, so all
  // that is left is to move it to where the clip sits on the timeline — and to
  // fade whichever ends of it are dissolving, so the sound crosses over with
  // the picture rather than the two takes talking over each other.
  for (const { clip, input, start } of withStarts(clips, leadIn)) {
    const volume = clip.volume ?? 1
    if (clip.kind !== 'video' || !clip.hasAudio || volume <= 0 || clip.duration <= 0) continue
    const fades: AudioFades = {
      in: overlapInto(clips, input),
      out: overlapInto(clips, input + 1),
      length: Math.max(0, clip.duration),
    }
    const shape = fades.in > 0 || fades.out > 0 ? fades : undefined
    chains.push(`[${input}:a]${placeAudio(start, volume, shape)}[c${input}]`)
    placed.push(`[c${input}]`)
  }

  // A layer's own sound, placed the same way. It is in the mix because the
  // preview plays it: a layer whose dialogue you can hear while editing and
  // cannot hear in the export is the worst of the three possible outcomes.
  // Its start time is already absolute, so unlike a picture clip's it needs no
  // lead-in added to it.
  overlays.forEach((clip, index) => {
    const volume = clip.volume ?? 1
    if (clip.kind !== 'video' || !clip.hasAudio || volume <= 0) return
    const label = `o${index}`
    chains.push(`[${overlayInputOffset + index}:a]${placeAudio(clip.startTime, volume)}[${label}]`)
    placed.push(`[${label}]`)
  })

  audio.forEach((clip, index) => {
    const label = `a${index}`
    chains.push(
      `[${audioInputOffset + index}:a]${placeAudio(clip.startTime, clip.volume)}[${label}]`,
    )
    placed.push(`[${label}]`)
  })

  const hasAudio = placed.length > 0
  if (placed.length === 1) {
    chains.push(`${placed[0]}anull[aout]`)
  } else if (placed.length > 1) {
    // normalize=0 keeps every clip at its own level; the default would quietly
    // divide the volume by the number of inputs, so adding a music bed would
    // duck the narration it is supposed to sit under.
    chains.push(`${placed.join('')}amix=inputs=${placed.length}:duration=longest:normalize=0[aout]`)
  }

  args.push('-filter_complex', chains.join(';'))

  // --- Mapping and encoding ---------------------------------------------
  args.push('-map', '[vout]')
  if (hasAudio) args.push('-map', '[aout]')

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    spec.preset ?? 'veryfast',
    '-crf',
    String(spec.crf ?? 23),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
  )

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  } else {
    args.push('-an')
  }

  args.push(
    // Puts the moov atom first so the file starts playing before it is fully
    // downloaded — worth it for something people will share.
    '-movflags',
    '+faststart',
    '-t',
    sec(outputDuration),
    outputFile,
  )

  return { args, durationSeconds: outputDuration }
}
