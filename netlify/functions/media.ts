import type { Config } from '@netlify/functions'
import { isAllowedMediaUrl, jsonError, passthroughHeaders } from './_shared'

/**
 * Streams provider media through our own origin.
 *
 * The app tries a direct browser fetch first — that is free and has no size
 * cap. This is the fallback for when the provider CDN does not send CORS
 * headers, and it matters because media read cross-origin taints the export
 * canvas, which would silently break MP4 export.
 *
 * No API key is involved: the URLs handed to this endpoint are already-signed
 * public result URLs. That is also why the allowlist has to be strict — without
 * it this would be an open proxy anyone could point at anything.
 */

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const raw = url.searchParams.get('url')

  if (!raw) {
    return jsonError(400, 'Missing "url" query parameter.')
  }

  const check = isAllowedMediaUrl(raw)
  if (!check.ok) {
    return jsonError(403, check.reason)
  }

  try {
    const upstream = await fetch(check.url, {
      // Forward Range so <video> can seek through the proxy.
      headers: request.headers.has('range')
        ? { range: request.headers.get('range') as string }
        : undefined,
    })

    if (!upstream.ok && upstream.status !== 206) {
      return jsonError(upstream.status, `Provider returned ${upstream.status} for that media URL.`)
    }

    const headers = passthroughHeaders(upstream.headers)
    // Generated media is immutable at its URL, so let the browser keep it.
    headers.set('cache-control', 'public, max-age=31536000, immutable')

    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (error) {
    return jsonError(
      502,
      'Could not fetch that media URL.',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export const config: Config = {
  path: '/api/media',
}
