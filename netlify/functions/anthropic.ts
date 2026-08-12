import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { jsonError, passthroughHeaders, requireServerKey } from '../lib/proxy'

/**
 * Proxy to Anthropic's Messages API, using this deployment's own Claude key.
 *
 * Like fal, the key here belongs to the site rather than the caller, so this
 * endpoint spends the operator's money — which is why every request must carry
 * a verified session first, same as /api/fal.
 *
 *   POST /api/anthropic/v1/messages -> generate
 *
 * Unlike fal, there is no queue to poll: a Messages API call answers directly,
 * well inside a Netlify function's run time, so this is a plain request/response
 * pass-through rather than a submit-then-poll dance.
 */

const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

export default async (request: Request): Promise<Response> => {
  const session = await requireSession(request)
  if (!session.ok) return session.response

  const auth = requireServerKey('ANTHROPIC_API_KEY', 'idea generation and prompt improvement')
  if (!auth.ok) return auth.response

  if (request.method !== 'POST') {
    return jsonError(404, 'No such endpoint.')
  }

  const url = new URL(request.url)
  if (url.pathname.replace(/^\/api\/anthropic\/?/, '') !== 'v1/messages') {
    return jsonError(404, 'No such endpoint.')
  }

  // Built fresh rather than copied from the request, so the caller's session
  // token is never forwarded to Anthropic, and the version header cannot be
  // overridden by whoever is calling this endpoint.
  const headers = new Headers({
    'x-api-key': auth.key,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
  })

  try {
    const upstream = await fetch(`${ANTHROPIC_ORIGIN}/v1/messages`, {
      method: 'POST',
      headers,
      body: await request.arrayBuffer(),
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders(upstream.headers),
    })
  } catch (error) {
    return jsonError(
      502,
      'Could not reach the Claude API.',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export const config: Config = {
  path: '/api/anthropic/*',
}
