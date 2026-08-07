/**
 * Asking ffmpeg whether a file actually has sound.
 *
 * The exporter has to know before it builds the filtergraph, because naming
 * `[n:a]` on an input with no audio stream does not degrade — it fails the
 * whole render. Guessing from the container or the mime type is not good
 * enough: an MP4 from a phone has audio, an MP4 from an image-to-video model
 * usually does not, and both look identical from the outside.
 *
 * The only authority is the decoder we are about to hand the file to, and by
 * this point it is already loaded with the file already staged, so asking it
 * costs a header parse. Running ffmpeg with no output is the cheapest way to
 * get the stream table: it prints what it found, then exits with an error we
 * expect and ignore.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg'

/** A line of ffmpeg's stream table, e.g. `Stream #0:1(eng): Audio: aac …`. */
const AUDIO_STREAM = /Stream #\d+:\d+.*:\s*Audio:/

export function mentionsAudioStream(lines: readonly string[]): boolean {
  return lines.some((line) => AUDIO_STREAM.test(line))
}

/**
 * Whether `file`, already written into the ffmpeg filesystem, carries audio.
 *
 * Answers false when the probe itself could not run. That is the safe way to
 * be wrong: a clip that stays silent is a disappointment, while claiming audio
 * that is not there loses the entire export.
 */
export async function hasAudioStream(ffmpeg: FFmpeg, file: string): Promise<boolean> {
  const lines: string[] = []
  const collect = ({ message }: { message: string }) => lines.push(message)

  ffmpeg.on('log', collect)
  try {
    await ffmpeg.exec(['-hide_banner', '-i', file])
  } catch {
    // Nothing to report: whatever was logged before it gave up still decides.
  } finally {
    ffmpeg.off('log', collect)
  }

  return mentionsAudioStream(lines)
}
