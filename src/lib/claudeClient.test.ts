import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which token `/api/anthropic/*` is shown, and how a response comes back.
 *
 * Mirrors falClient.test.ts: the same access token has to be sent, because the
 * function verifies `aud` against it before spending the site's Anthropic
 * credits — see netlify/lib/auth.ts.
 */
const auth0Token = vi.fn<() => Promise<string | null>>()

vi.mock('./auth0/client', () => ({ auth0Token: () => auth0Token() }))

const { createMessage } = await import('./claudeClient')

function serve(body: unknown, status = 200): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
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

describe('createMessage', () => {
  it('posts to the Anthropic proxy with the model, system prompt and user turn', async () => {
    const calls = serve({ content: [{ type: 'text', text: 'hello' }] })

    await createMessage({
      model: 'claude-opus-5',
      system: 'Be brief.',
      prompt: 'Hi',
      maxTokens: 100,
    })

    expect(calls[0]?.url).toBe('/api/anthropic/v1/messages')
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>
    expect(body).toEqual({
      model: 'claude-opus-5',
      max_tokens: 100,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
    })
  })

  it('carries the Auth0 access token, which is what the function checks `aud` on', async () => {
    const calls = serve({ content: [{ type: 'text', text: 'hello' }] })

    await createMessage({ model: 'claude-opus-5', system: 's', prompt: 'p', maxTokens: 10 })

    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer auth0-access-token' })
  })

  it('sends no authorization header at all when nobody is signed in', async () => {
    auth0Token.mockResolvedValue(null)
    const calls = serve({ content: [{ type: 'text', text: 'hello' }] })

    await createMessage({ model: 'claude-opus-5', system: 's', prompt: 'p', maxTokens: 10 })

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('joins every text block in the response into one string', async () => {
    serve({
      content: [
        { type: 'text', text: 'first ' },
        { type: 'text', text: 'second' },
      ],
    })

    const text = await createMessage({
      model: 'claude-opus-5',
      system: 's',
      prompt: 'p',
      maxTokens: 10,
    })

    expect(text).toBe('first second')
  })

  it('ignores non-text content blocks', async () => {
    serve({ content: [{ type: 'text', text: 'kept' }, { type: 'tool_use' }] })

    const text = await createMessage({
      model: 'claude-opus-5',
      system: 's',
      prompt: 'p',
      maxTokens: 10,
    })

    expect(text).toBe('kept')
  })

  it('throws a ProviderError naming Anthropic when the proxy answers with an error', async () => {
    serve({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }, 404)

    await expect(
      createMessage({ model: 'claude-opus-5', system: 's', prompt: 'p', maxTokens: 10 }),
    ).rejects.toMatchObject({ name: 'ProviderError', provider: 'Anthropic', status: 404 })
  })
})
