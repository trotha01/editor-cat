import { describe, expect, it } from 'vitest'
import { mentionsAudioStream } from './probe'

/** Real lines, as ffmpeg 6 prints them for `ffmpeg -hide_banner -i file`. */
const withSound = [
  "Input #0, matroska,webm, from 'clip.webm':",
  '  Duration: 00:00:02.03, start: 0.000000, bitrate: 163 kb/s',
  '  Stream #0:0(eng): Video: vp8, yuv420p(progressive), 320x180, SAR 1:1 DAR 16:9, 60 tbr, 1k tbn (default)',
  '  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp (default)',
  'At least one output file must be specified',
]

const silent = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), yuv420p, 720x1280, 30 fps, 30 tbr',
  'At least one output file must be specified',
]

describe('mentionsAudioStream', () => {
  it('finds the audio line in a file that has one', () => {
    expect(mentionsAudioStream(withSound)).toBe(true)
  })

  it('reports no audio for a video with only a picture track', () => {
    expect(mentionsAudioStream(silent)).toBe(false)
  })

  it('says no rather than yes when the probe produced nothing', () => {
    // Claiming audio that is not there costs the whole export; missing some
    // only costs a silent clip.
    expect(mentionsAudioStream([])).toBe(false)
    expect(mentionsAudioStream(['clip.mp4: No such file or directory'])).toBe(false)
  })

  it('is not fooled by the word audio appearing elsewhere', () => {
    expect(
      mentionsAudioStream([
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'my audio recording.mp4':",
        '  Stream #0:0[0x1](und): Video: h264, yuv420p, 720x1280',
      ]),
    ).toBe(false)
  })
})
