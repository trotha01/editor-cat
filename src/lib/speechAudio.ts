/**
 * Turning whatever is on the timeline into something a transcriber will accept.
 *
 * Recordings arrive as WebM/Opus, music as MP3, generated clips as MP4 — and
 * some of the speech worth captioning is inside a video file rather than in an
 * audio one at all. Rather than teaching the transcriber about every container,
 * the browser decodes each source and we re-encode exactly what we want: mono,
 * 16kHz, 16-bit PCM. That is what speech recognisers are trained on, so nothing
 * is lost by downsampling to it, and it makes the request size predictable
 * instead of depending on how a provider happened to encode a clip.
 *
 * Predictable matters, because the proxy in front of ElevenLabs is a serverless
 * function with a payload ceiling. At this format audio costs 32KB a second, so
 * long sources are cut into chunks and transcribed one at a time — see
 * `chunkRanges`, which is pure and is where the arithmetic that has to line back
 * up lives.
 */
import { encodeWav, WAV_MIME } from './countdown'

/** What speech recognition wants, and no more than it wants. */
export const SPEECH_SAMPLE_RATE = 16000

/**
 * How much audio goes in one request.
 *
 * Two minutes is ~3.8MB at the format above, comfortably inside the 6MB
 * serverless payload ceiling with room for the multipart envelope.
 */
export const CHUNK_SECONDS = 120

export interface TimeRange {
  /** Seconds into the source file. */
  from: number
  to: number
}

/**
 * Cuts a stretch of source audio into transcribable chunks.
 *
 * Boundaries are blunt — a word straddling one is split — so the chunk is made
 * as long as the payload allows rather than as short as is convenient, and a
 * take of any ordinary length is transcribed in a single pass with no seams at
 * all.
 */
export function chunkRanges(from: number, to: number, chunkSeconds = CHUNK_SECONDS): TimeRange[] {
  const start = Math.max(0, from)
  const end = Math.max(start, to)
  if (end - start <= chunkSeconds) return [{ from: start, to: end }]

  const ranges: TimeRange[] = []
  for (let cursor = start; cursor < end - 1e-6; cursor += chunkSeconds) {
    ranges.push({ from: cursor, to: Math.min(end, cursor + chunkSeconds) })
  }
  return ranges
}

/**
 * Decodes media bytes to raw samples.
 *
 * Kept separate from the slicing below so a source is decoded once however many
 * chunks come out of it — decoding is the expensive half, and a five-minute take
 * would otherwise be decoded three times over.
 */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const Context =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) throw new Error('This browser cannot decode audio, so captions are unavailable.')

  const context = new Context()
  try {
    return await context.decodeAudioData(await blob.arrayBuffer())
  } catch {
    throw new Error('That file could not be decoded, so there is no audio in it to transcribe.')
  } finally {
    void context.close()
  }
}

/**
 * One stretch of a decoded source, as mono samples at `SPEECH_SAMPLE_RATE`.
 *
 * This is the common currency of transcription: the WAV below is an encoding of
 * it for the provider that wants a file, and the in-browser model takes it as it
 * is. Both therefore hear exactly the same audio, which is what makes the two
 * engines comparable rather than merely both present.
 *
 * Channels are averaged rather than one being taken: a take recorded with the
 * voice panned, or a stereo clip whose dialogue sits on one side, would
 * otherwise come back half transcribed.
 */
export async function speechSamples(buffer: AudioBuffer, range: TimeRange): Promise<Float32Array> {
  const rate = buffer.sampleRate
  const first = Math.max(0, Math.floor(range.from * rate))
  const last = Math.min(buffer.length, Math.ceil(range.to * rate))
  const frames = Math.max(0, last - first)
  if (frames === 0) return new Float32Array(0)

  const mono = new Float32Array(frames)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < frames; index += 1) {
      mono[index] = (mono[index] ?? 0) + (data[first + index] ?? 0)
    }
  }
  if (buffer.numberOfChannels > 1) {
    for (let index = 0; index < frames; index += 1) {
      mono[index] = (mono[index] ?? 0) / buffer.numberOfChannels
    }
  }

  return resample(mono, rate, SPEECH_SAMPLE_RATE)
}

/** The same stretch, wrapped as a WAV file for a provider that wants one. */
export async function speechChunkWav(buffer: AudioBuffer, range: TimeRange): Promise<Blob> {
  const samples = await speechSamples(buffer, range)
  return new Blob([encodeWav(samples, SPEECH_SAMPLE_RATE)], { type: WAV_MIME })
}

/**
 * Resamples through an OfflineAudioContext rather than by hand.
 *
 * The browser's resampler is properly filtered; dropping samples to hit a rate
 * would alias the very frequencies speech recognition listens to. Sources
 * already at the target rate skip it entirely.
 */
async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to || samples.length === 0) return samples

  const length = Math.max(1, Math.round((samples.length * to) / from))
  const offline = new OfflineAudioContext(1, length, to)
  const source = offline.createBufferSource()
  const input = offline.createBuffer(1, samples.length, from)
  input.getChannelData(0).set(samples)
  source.buffer = input
  source.connect(offline.destination)
  source.start()
  return (await offline.startRendering()).getChannelData(0)
}
