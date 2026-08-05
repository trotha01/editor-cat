import { describe, expect, it } from 'vitest'
import { ProviderError, explainStatus, extractMessage, toDisplayMessage } from './errors'

describe('extractMessage', () => {
  it('reads a plain error field', () => {
    expect(extractMessage({ error: 'boom' })).toBe('boom')
    expect(extractMessage({ message: 'boom' })).toBe('boom')
  })

  it('flattens fal validation errors into something readable', () => {
    const body = { detail: [{ msg: 'field required', loc: ['body', 'image_url'] }] }
    expect(extractMessage(body)).toBe('field required (body.image_url)')
  })

  it('reads the nested ElevenLabs detail shape', () => {
    expect(extractMessage({ detail: { status: 'invalid_api_key', message: 'Bad key' } })).toBe(
      'Bad key',
    )
  })

  it('passes plain strings through and ignores empty input', () => {
    expect(extractMessage('just text')).toBe('just text')
    expect(extractMessage('')).toBeUndefined()
    expect(extractMessage(null)).toBeUndefined()
    expect(extractMessage({})).toBeUndefined()
  })
})

describe('explainStatus', () => {
  it('tells the user what to actually do', () => {
    expect(explainStatus('fal.ai', 402)).toMatch(/credit/i)
    expect(explainStatus('fal.ai', 404)).toMatch(/model ID/i)
    expect(explainStatus('fal.ai', 429)).toMatch(/rate limit/i)
    expect(explainStatus('ElevenLabs', 503)).toMatch(/server error/i)
  })

  it('sends an ElevenLabs rejection to Settings, where its key actually lives', () => {
    expect(explainStatus('ElevenLabs', 401)).toMatch(/key/i)
    expect(explainStatus('ElevenLabs', 401)).toMatch(/settings/i)
  })

  it('never tells the user to fix a fal key, because there is no field for one', () => {
    // fal runs on the site's own account. Advice to check a Settings field that
    // does not exist is worse than no advice at all.
    for (const status of [401, 403, 402, 503]) {
      expect(explainStatus('fal.ai', status)).not.toMatch(/settings/i)
    }
    expect(explainStatus('fal.ai', 401)).toMatch(/sign in/i)
    expect(explainStatus('fal.ai', 503)).toMatch(/deployed/i)
  })
})

describe('toDisplayMessage', () => {
  it('combines a provider message with its detail', () => {
    const error = new ProviderError('fal.ai', 422, 'Rejected these settings.', 'duration invalid')
    expect(toDisplayMessage(error)).toBe('Rejected these settings. — duration invalid')
  })

  it('reports a cancellation plainly rather than as a crash', () => {
    expect(toDisplayMessage(new DOMException('Aborted', 'AbortError'))).toBe('Cancelled.')
  })

  it('handles ordinary errors and stray values', () => {
    expect(toDisplayMessage(new Error('nope'))).toBe('nope')
    expect(toDisplayMessage('raw string')).toBe('raw string')
  })
})
