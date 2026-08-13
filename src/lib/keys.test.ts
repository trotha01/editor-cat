import { beforeEach, describe, expect, it } from 'vitest'
import { purgeStoredKeys } from './keys'

/**
 * Taking back the keys this app used to ask for.
 *
 * Worth a test of its own precisely because nothing on screen shows the result:
 * the field is gone, so a purge that quietly stopped working would leave live
 * provider credentials in local storage on every device that ever held one, and
 * nobody would notice for as long as the app kept working — which it would.
 */

beforeEach(() => {
  window.localStorage.clear()
})

describe('purgeStoredKeys', () => {
  it('removes a remembered key and the flag that remembered it', () => {
    window.localStorage.setItem('editor-cat.keys.v1', JSON.stringify({ elevenlabs: 'sk-secret' }))
    window.localStorage.setItem('editor-cat.keys.remember.v1', '1')

    expect(purgeStoredKeys()).toBe(true)

    expect(window.localStorage.getItem('editor-cat.keys.v1')).toBeNull()
    expect(window.localStorage.getItem('editor-cat.keys.remember.v1')).toBeNull()
  })

  it('says so when there was nothing to take back', () => {
    expect(purgeStoredKeys()).toBe(false)
  })

  it('leaves everything else this app stores alone', () => {
    // Preferences and the sidebar state live in the same storage. A purge that
    // reached them would log people out of their own layout.
    window.localStorage.setItem('editor-cat.prefs.v1', '{"imageModel":"x"}')
    purgeStoredKeys()
    expect(window.localStorage.getItem('editor-cat.prefs.v1')).toBe('{"imageModel":"x"}')
  })
})
