/**
 * A tiny WAV synthesiser, so the end-to-end test can add a real music file to
 * the timeline without committing a binary fixture to the repo.
 *
 * It is a plain 16-bit PCM sine tone — enough for the app to decode, read a
 * duration from, place on a track, and hand to ffmpeg.
 */

export function sineWav({ seconds = 5, frequency = 220, sampleRate = 44100 } = {}) {
  const frames = Math.floor(seconds * sampleRate)
  const bytesPerSample = 2
  const dataBytes = frames * bytesPerSample

  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)

  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // subchunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28) // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample

  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < frames; i++) {
    // Quiet enough that it reads as a bed rather than a test tone.
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.25 * 0x7fff
    buffer.writeInt16LE(Math.round(value), 44 + i * bytesPerSample)
  }

  return buffer
}
