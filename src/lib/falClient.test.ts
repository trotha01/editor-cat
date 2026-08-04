import { describe, expect, it } from 'vitest'
import { toProxyPath } from './falClient'

describe('toProxyPath', () => {
  it('rewrites a queue URL onto our own proxy', () => {
    expect(toProxyPath('https://queue.fal.run/fal-ai/flux/requests/abc123/status')).toBe(
      '/api/fal/fal-ai/flux/requests/abc123/status',
    )
  })

  it('preserves the query string', () => {
    expect(toProxyPath('https://queue.fal.run/fal-ai/flux/requests/abc?logs=1')).toBe(
      '/api/fal/fal-ai/flux/requests/abc?logs=1',
    )
  })

  it('handles a nested model id without mangling the request path', () => {
    // fal's queue path uses only the first two segments of a nested model id,
    // which is exactly why we rewrite its URL instead of rebuilding one.
    expect(toProxyPath('https://queue.fal.run/fal-ai/kling-video/requests/xyz')).toBe(
      '/api/fal/fal-ai/kling-video/requests/xyz',
    )
  })

  it('falls back sanely for a relative or malformed value', () => {
    expect(toProxyPath('fal-ai/flux/requests/abc')).toBe('/api/fal/fal-ai/flux/requests/abc')
    expect(toProxyPath('/fal-ai/flux')).toBe('/api/fal/fal-ai/flux')
  })
})
