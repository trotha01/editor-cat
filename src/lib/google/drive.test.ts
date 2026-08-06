import { describe, expect, it } from 'vitest'
import { kindForMime } from './drive'

describe('kindForMime', () => {
  it('maps the media types the editor can use', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/webm;codecs=opus')).toBe('audio')
  })

  it('rejects anything else, so Docs and folders never reach the library', () => {
    // The Picker can be pointed at a folder view, and a stray Doc in a media
    // folder should be ignored rather than downloaded as a video.
    expect(kindForMime('application/vnd.google-apps.document')).toBeNull()
    expect(kindForMime('application/vnd.google-apps.folder')).toBeNull()
    expect(kindForMime('application/pdf')).toBeNull()
  })
})
