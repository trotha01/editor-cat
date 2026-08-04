import type { Config } from '@netlify/functions'
import { isBlockedHost, jsonError, passthroughHeaders, requireKey, upstreamPath } from './_shared'

/**
 * Pass-through proxy to fal.ai's queue API.
 *
 * Every call here is short by design. Video generation takes minutes, which is
 * far longer than a Netlify function may run (~10s), so the browser drives the
 * queue: submit, then poll status, then fetch the result. Each of those is a
 * fast request that comfortably fits the timeout.
 *
 *   POST /api/fal/fal-ai/flux/dev                        -> submit
 *   GET  /api/fal/fal-ai/flux/requests/<id>/status       -> poll
 *   GET  /api/fal/fal-ai/flux/requests/<id>              -> result
 *   PUT  /api/fal/fal-ai/flux/requests/<id>/cancel       -> cancel
 */

const FAL_QUEUE_ORIGIN = 'https://queue.fal.run'

export default async (request: Request): Promise<Response> => {
  const auth = requireKey(request, 'x-fal-key', 'fal.ai')
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const path = upstreamPath(url.pathname, '/api/fal')

  if (!path) {
    return jsonError(400, 'Missing fal endpoint path.')
  }

  const target = new URL(`${FAL_QUEUE_ORIGIN}/${path}`)
  target.search = url.search

  // The path is attacker-controllable, so confirm it did not escape the origin
  // (e.g. via a path that resolves to another host) before we attach the key.
  if (target.origin !== FAL_QUEUE_ORIGIN || isBlockedHost(target.hostname)) {
    return jsonError(400, 'Invalid fal endpoint path.')
  }

  const headers = new Headers({
    // fal expects its key in this exact form.
    authorization: `Key ${auth.key}`,
    accept: 'application/json',
  })
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders(upstream.headers),
    })
  } catch (error) {
    return jsonError(
      502,
      'Could not reach fal.ai.',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export const config: Config = {
  path: '/api/fal/*',
}
