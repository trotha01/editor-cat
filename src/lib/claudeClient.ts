/**
 * Direct client for Anthropic's Messages API.
 *
 * Routed through /api/anthropic rather than straight to Anthropic, for the same
 * reason as fal: the API key belongs to this deployment, not the caller, so it
 * is attached server-side and never reaches the browser. What is sent instead
 * is the user's Auth0 access token, which the function verifies before
 * spending the site's credits — see src/lib/falClient.ts, which the same
 * verification was written for.
 */
import { providerErrorFrom } from './errors'
import { auth0Token } from './auth0/client'

const PROXY_BASE = '/api/anthropic'

interface ContentBlock {
  type: string
  text?: string
}

interface MessagesResponse {
  content: ContentBlock[]
}

export interface CreateMessageOptions {
  model: string
  system: string
  prompt: string
  maxTokens: number
  signal?: AbortSignal
}

/** Sends a single-turn request to Claude and returns its text response. */
export async function createMessage({
  model,
  system,
  prompt,
  maxTokens,
  signal,
}: CreateMessageOptions): Promise<string> {
  // Read per request, not captured, so a stale token from before a renewal is
  // never the one attached.
  const token = await auth0Token()
  const response = await fetch(`${PROXY_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Absent when nobody is signed in — mock mode never reaches here, and a
      // checkout with no Auth0 tenant is expected to run with anonymous access
      // allowed on the function side.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  })

  if (!response.ok) throw await providerErrorFrom('Anthropic', response)

  const body = (await response.json()) as MessagesResponse
  return body.content
    .filter((block): block is ContentBlock & { text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
