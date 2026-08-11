import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which token `/api/fal/*` is shown, and when it is shown none.
 *
 * Worth a test of its own because getting it wrong is silent. There are two
 * Auth0 tokens in play — the access token for this site's own API, and the ID
 * token Supabase takes because it is the only one that can carry the `role`
 * claim — and both are signed by the same tenant. Send the ID token here and the
 * signature verifies perfectly; the function refuses it on `aud`, and the
 * symptom is a 401 from generation on an account that is plainly signed in.
 */
const auth0Token = vi.fn<() => Promise<string | null>>()

vi.mock('./auth0/client', () => ({ auth0Token: () => auth0Token() }))
vi.mock('./mock', () => ({ isMockEnabled: () => false, mockFal: vi.fn() }))

const { submit, toProxyPath } = await import('./falClient')

function serve(): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(
      new Response(JSON.stringify({ request_id: 'abc' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  return calls
}

beforeEach(() => {
  auth0Token.mockResolvedValue('auth0-access-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the token the proxy is sent', () => {
  it('carries the Auth0 access token, which is what the function checks `aud` on', async () => {
    const calls = serve()

    await submit('fal-ai/flux/dev', { prompt: 'a cat' })

    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer auth0-access-token',
    })
  })

  it('sends no authorization header at all when nobody is signed in', async () => {
    // A signed-out browser must not send an empty or literal-null bearer: the
    // function reads a missing header as the anonymous case, which is the only
    // thing `FAL_PROXY_ALLOW_ANONYMOUS` can then let through, and reads a
    // present-but-unusable one as a rejected session.
    auth0Token.mockResolvedValue(null)
    const calls = serve()

    await submit('fal-ai/flux/dev', { prompt: 'a cat' })

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('reads the token per request, so a job that polls for minutes survives a renewal', async () => {
    const calls = serve()

    await submit('fal-ai/flux/dev', { prompt: 'a cat' })
    auth0Token.mockResolvedValue('a-renewed-token')
    await submit('fal-ai/flux/dev', { prompt: 'a dog' })

    expect(calls[1]?.init?.headers).toMatchObject({ authorization: 'Bearer a-renewed-token' })
  })
})

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

  it('handles an owner-scoped model id, which carries no fal-ai/ prefix', () => {
    // Seedance is published as `bytedance/...`, so nothing here may assume the
    // first segment is always `fal-ai`.
    expect(toProxyPath('https://queue.fal.run/bytedance/seedance-2.0/requests/xyz/status')).toBe(
      '/api/fal/bytedance/seedance-2.0/requests/xyz/status',
    )
  })

  it('falls back sanely for a relative or malformed value', () => {
    expect(toProxyPath('fal-ai/flux/requests/abc')).toBe('/api/fal/fal-ai/flux/requests/abc')
    expect(toProxyPath('/fal-ai/flux')).toBe('/api/fal/fal-ai/flux')
  })
})
