import { describe, expect, it } from 'vitest'
import {
  ProviderError,
  RetriedError,
  explainStatus,
  extractMessage,
  isAbort,
  isRetryable,
  toDisplayMessage,
} from './errors'

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
    expect(explainStatus('ElevenLabs', 500)).toMatch(/server error/i)
  })

  it('never sends anyone to Settings for a key, because there is no field for one', () => {
    // Both providers run on the site's own accounts. Advice to go and check a
    // Settings field that does not exist is worse than no advice at all — and
    // this is the check that outlived the field: the ElevenLabs messages used to
    // say exactly that, correctly, right up until the key moved.
    for (const provider of ['fal.ai', 'ElevenLabs'] as const) {
      for (const status of [401, 403, 402, 503]) {
        expect(explainStatus(provider, status)).not.toMatch(/settings/i)
        expect(explainStatus(provider, status)).not.toMatch(/your .*key/i)
      }
      expect(explainStatus(provider, 401)).toMatch(/sign in/i)
      expect(explainStatus(provider, 503)).toMatch(/deployed/i)
      // The site's account, not the reader's, is the one that ran dry.
      expect(explainStatus(provider, 402)).toMatch(/this site's/i)
    }
  })

  it('leaves a 403 to explain itself, since the proxy has three ways to mean it', () => {
    // An account that is not on this deployment's list, an endpoint it will not
    // forward, and a voice it will not delete all arrive as 403 with a detail
    // that says which. A confident guess here would contradict two of them.
    expect(explainStatus('ElevenLabs', 403)).toMatch(/details below/i)
  })
})

describe('isRetryable', () => {
  it('asks again when the answer was about the moment rather than the request', () => {
    // The two that a queue of caption chunks actually runs into: a service
    // metering a burst, and a service having a bad minute.
    expect(isRetryable(new ProviderError('fal.ai', 429, 'Slow down.'))).toBe(true)
    expect(isRetryable(new ProviderError('fal.ai', 500, 'Boom.'))).toBe(true)
    expect(isRetryable(new ProviderError('fal.ai', 502, 'Boom.'))).toBe(true)
  })

  it('does not ask again about a request that ran out of time', () => {
    // The exception among the 5xx. A retry is the same request — the same bytes
    // uploaded, the same work asked for — so where the slowness is the payload
    // it can only fail the same way, later and heavier. It is also what `run`
    // raises when a job outlives its own timeout, and three of those in a row is
    // three quarters of an hour.
    expect(isRetryable(new ProviderError('fal.ai', 504, 'Generation timed out.'))).toBe(false)
    expect(explainStatus('fal.ai', 504)).not.toMatch(/try again/i)
  })

  it('does not ask again about a decision the provider has already made', () => {
    // A rejected session is still rejected in two seconds and a refused input
    // is still refused, so three goes only make the same failure slower.
    expect(isRetryable(new ProviderError('fal.ai', 401, 'Sign in.'))).toBe(false)
    expect(isRetryable(new ProviderError('fal.ai', 422, 'Rejected.'))).toBe(false)
    expect(isRetryable(new ProviderError('fal.ai', 404, 'No such model.'))).toBe(false)
    expect(isRetryable(new ProviderError('fal.ai', 402, 'No credit.'))).toBe(false)
  })

  it('asks again when the request never got an answer at all', () => {
    // `fetch` rejects with a TypeError when the connection drops rather than
    // giving a status, and that is the most transient failure of the lot.
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('never asks again after a cancellation, which is not a fault to work around', () => {
    expect(isRetryable(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })

  it('leaves anything it cannot recognise alone', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(false)
    expect(isRetryable('a string')).toBe(false)
  })
})

describe('isAbort', () => {
  it('tells a cancellation from a failure', () => {
    expect(isAbort(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isAbort(new DOMException('Nope', 'NotSupportedError'))).toBe(false)
    expect(isAbort(new Error('AbortError'))).toBe(false)
  })
})

describe('RetriedError', () => {
  it('borrows the wording of what actually failed', () => {
    // So nothing downstream has to know this class exists to render it: the
    // provider's own advice is still the sentence the user reads.
    const cause = new ProviderError('fal.ai', 429, 'fal.ai is rate limiting you.', 'Slow down')
    const retried = new RetriedError(cause, 3)

    expect(toDisplayMessage(retried)).toBe('fal.ai is rate limiting you. — Slow down')
    expect(retried.attempts).toBe(3)
    expect(retried.cause).toBe(cause)
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

describe('a refusal from the provider is not a refusal from us', () => {
  it('sends the user to sign in only when it was our own session check', () => {
    expect(explainStatus('ElevenLabs', 401)).toMatch(/sign in/i)
  })

  it('says the site’s account was refused when the provider is the one refusing', () => {
    // The site's key is revoked, or the workspace has no access to an endpoint —
    // as happened with dubbing's resource API, which is in closed beta. Signing
    // in again cannot touch any of that.
    const message = explainStatus('ElevenLabs', 401, true)
    expect(message).not.toMatch(/sign in/i)
    expect(message).toMatch(/nothing you can fix/i)
  })

  it('does not blame this site’s setup for a feature the workspace lacks', () => {
    // Our proxy says 403 for an endpoint it will not forward, which is a
    // deployment problem. ElevenLabs says 403 for a workspace not entitled to a
    // feature — as it does for dubbing's segment editing — which is not.
    expect(explainStatus('ElevenLabs', 403)).toMatch(/this site would not allow/i)
    const message = explainStatus('ElevenLabs', 403, true)
    expect(message).toMatch(/ElevenLabs refused/i)
    expect(message).toMatch(/nothing you can fix/i)
  })
})
