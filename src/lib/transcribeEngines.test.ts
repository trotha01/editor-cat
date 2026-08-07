import { describe, expect, it } from 'vitest'
import { defaultEngineId, whisperLanguageFor } from './transcribeEngines'

describe('defaultEngineId', () => {
  it('uses the paid transcriber when there is a key to pay with', () => {
    expect(defaultEngineId(true)).toBe('elevenlabs')
  })

  it('falls to the browser when there is not, rather than to nothing at all', () => {
    expect(defaultEngineId(false)).toBe('browser')
  })
})

describe('whisperLanguageFor', () => {
  it('translates the ISO code the UI uses into the name Whisper wants', () => {
    // Two vocabularies for the same thing, and neither engine takes the other's.
    expect(whisperLanguageFor('spa')).toBe('spanish')
    expect(whisperLanguageFor('cmn')).toBe('chinese')
  })

  it('says nothing for "detect automatically", which is the empty choice', () => {
    expect(whisperLanguageFor(undefined)).toBeUndefined()
    expect(whisperLanguageFor('')).toBeUndefined()
  })

  it('says nothing for a code it has no name for, rather than passing it through', () => {
    // Whisper rejects an unknown language outright, so an unmapped code has to
    // become detection rather than an error.
    expect(whisperLanguageFor('zxx')).toBeUndefined()
  })
})
