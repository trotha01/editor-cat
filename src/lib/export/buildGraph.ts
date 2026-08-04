/**
 * Builds the ffmpeg command line for an export.
 *
 * This is deliberately a pure function over plain data: given clips and
 * voiceover takes it returns argv, with no wasm, no filesystem and no browser
 * involved. Export bugs are almost always filtergraph bugs, and this way they
 * can be caught by a unit test asserting on the arguments instead of by
 * rendering a video and squinting at it.
 *
 * A note on audio: clip audio is not mixed in. Most image-to-video models
 * return silent footage, and conditionally wiring per-clip audio streams
 * requires knowing which inputs have an audio track at all — which cannot be
 * known without probing every file first. The voiceover is the soundtrack, and
 * the preview mutes clips to match, so what you hear is what you export.
 */

export interface ExportClip {
  /** Filename as written into the ffmpeg virtual filesystem. */
  file: string
  kind: 'image' | 'video'
  /** Seconds into the source. Ignored for images. */
  inPoint: number
  /** Seconds of output this clip contributes. */
  duration: number
}

export interface ExportVoiceover {
  file: string
  /** Seconds from the start of the timeline. */
  startTime: number
  duration: number
}

export interface ExportSpec {
  clips: readonly ExportClip[]
  voiceovers: readonly ExportVoiceover[]
  width: number
  height: number
  fps: number
  outputFile: string
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

export function totalVisualDuration(clips: readonly ExportClip[]): number {
  return clips.reduce((sum, clip) => sum + Math.max(0, clip.duration), 0)
}

export function totalAudioEnd(voiceovers: readonly ExportVoiceover[]): number {
  return voiceovers.reduce((max, take) => Math.max(max, take.startTime + take.duration), 0)
}

export function buildExportPlan(spec: ExportSpec): ExportPlan {
  const { clips, voiceovers, width, height, fps, outputFile } = spec

  if (clips.length === 0) {
    throw new Error('Add at least one clip to the timeline before exporting.')
  }

  const visualDuration = totalVisualDuration(clips)
  const audioEnd = totalAudioEnd(voiceovers)
  const outputDuration = Math.max(visualDuration, audioEnd)

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

  const audioInputOffset = clips.length
  for (const take of voiceovers) {
    args.push('-i', take.file)
  }

  // --- Video graph -------------------------------------------------------
  const chains: string[] = []
  const normalized: string[] = []

  clips.forEach((_, index) => {
    const label = `v${index}`
    chains.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},` +
        `format=yuv420p[${label}]`,
    )
    normalized.push(`[${label}]`)
  })

  const needsPad = audioEnd > visualDuration + 0.01
  const concatOut = needsPad ? '[vcat]' : '[vout]'
  chains.push(`${normalized.join('')}concat=n=${clips.length}:v=1:a=0${concatOut}`)

  if (needsPad) {
    // The voiceover runs past the last clip, so hold its final frame rather
    // than cutting to black mid-sentence.
    chains.push(`[vcat]tpad=stop_mode=clone:stop_duration=${sec(audioEnd - visualDuration)}[vout]`)
  }

  // --- Audio graph -------------------------------------------------------
  const hasAudio = voiceovers.length > 0
  if (hasAudio) {
    const delayed: string[] = []
    voiceovers.forEach((take, index) => {
      const input = audioInputOffset + index
      const label = `a${index}`
      const delayMs = Math.max(0, Math.round(take.startTime * 1000))
      // all=1 applies the delay to every channel, so it works for mono and
      // stereo takes alike without knowing the layout up front.
      chains.push(`[${input}:a]adelay=${delayMs}:all=1,aresample=48000[${label}]`)
      delayed.push(`[${label}]`)
    })

    if (delayed.length === 1) {
      chains.push(`${delayed[0]}anull[aout]`)
    } else {
      // normalize=0 keeps each take at its recorded level; the default would
      // quietly halve the volume as soon as a second take is added.
      chains.push(
        `${delayed.join('')}amix=inputs=${delayed.length}:duration=longest:normalize=0[aout]`,
      )
    }
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
