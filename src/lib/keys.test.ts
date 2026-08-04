import { beforeEach, describe, expect, it } from 'vitest'
import { clearKeys, loadKeys, maskKey, saveKeys } from './keys'

describe('key storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearKeys()
  })

  it('does not write keys to storage unless remember is on', () => {
    saveKeys({ fal: 'fal-secret', elevenlabs: 'el-secret', remember: false })

    // The whole point of the opt-out: nothing durable is left behind.
    expect(JSON.stringify(window.localStorage)).not.toContain('fal-secret')
    expect(JSON.stringify(window.localStorage)).not.toContain('el-secret')
  })

  it('keeps unremembered keys usable for the rest of the session', () => {
    saveKeys({ fal: 'fal-secret', elevenlabs: '', remember: false })
    expect(loadKeys().fal).toBe('fal-secret')
  })

  it('persists and reloads keys when remember is on', () => {
    saveKeys({ fal: 'fal-secret', elevenlabs: 'el-secret', remember: true })
    clearKeysFromMemoryOnly()

    const loaded = loadKeys()
    expect(loaded.fal).toBe('fal-secret')
    expect(loaded.elevenlabs).toBe('el-secret')
    expect(loaded.remember).toBe(true)
  })

  it('erases already-stored keys when remember is turned off', () => {
    saveKeys({ fal: 'fal-secret', elevenlabs: 'el-secret', remember: true })
    saveKeys({ fal: 'fal-secret', elevenlabs: 'el-secret', remember: false })

    // Turning the setting off has to clean up, not just stop writing.
    expect(JSON.stringify(window.localStorage)).not.toContain('fal-secret')
  })

  it('clearKeys removes everything', () => {
    saveKeys({ fal: 'fal-secret', elevenlabs: 'el-secret', remember: true })
    clearKeys()
    expect(loadKeys()).toEqual({ fal: '', elevenlabs: '', remember: false })
  })

  it('survives corrupted storage instead of throwing', () => {
    window.localStorage.setItem('editor-cat.keys.remember.v1', '1')
    window.localStorage.setItem('editor-cat.keys.v1', '{not json')
    expect(() => loadKeys()).not.toThrow()
  })
})

/** Simulates a page reload: storage survives, module memory does not. */
function clearKeysFromMemoryOnly() {
  const remember = window.localStorage.getItem('editor-cat.keys.remember.v1')
  const stored = window.localStorage.getItem('editor-cat.keys.v1')
  clearKeys()
  if (remember) window.localStorage.setItem('editor-cat.keys.remember.v1', remember)
  if (stored) window.localStorage.setItem('editor-cat.keys.v1', stored)
}

describe('maskKey', () => {
  it('shows enough to recognise a key without revealing it', () => {
    const masked = maskKey('abcd1234567890wxyz')
    expect(masked.startsWith('abcd')).toBe(true)
    expect(masked.endsWith('wxyz')).toBe(true)
    expect(masked).not.toContain('1234567890')
  })

  it('fully masks short keys and handles empty input', () => {
    expect(maskKey('abc')).toBe('•••')
    expect(maskKey('')).toBe('')
    expect(maskKey('   ')).toBe('')
  })
})
