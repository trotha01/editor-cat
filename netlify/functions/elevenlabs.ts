import type { Config } from '@netlify/functions'
import { isBlockedHost, jsonError, passthroughHeaders, requireKey, upstreamPath } from './_shared'

/**
 * Pass-through proxy to the ElevenLabs API.
 *
 *   GET  /api/elevenlabs/v1/voices                       -> list target voices
 *   GET  /api/elevenlabs/v1/models                       -> find a conversion-capable model
 *   POST /api/elevenlabs/v1/speech-to-speech/<voice_id>  -> convert a recording
 *
 * The conversion request is multipart with the recording attached. Opus audio
 * runs about 4KB/s, so a take would have to be roughly twenty minutes long
 * before it approached the 6MB function payload ceiling — and takes are
 * recorded per pass, not per project.
 */

const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io'

export default async (request: Request): Promise<Response> => {
  const auth = requireKey(request, 'xi-api-key', 'ElevenLabs')
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const path = upstreamPath(url.pathname, '/api/elevenlabs')

  if (!path) {
    return jsonError(400, 'Missing ElevenLabs endpoint path.')
  }

  const target = new URL(`${ELEVENLABS_ORIGIN}/${path}`)
  target.search = url.search

  if (target.origin !== ELEVENLABS_ORIGIN || isBlockedHost(target.hostname)) {
    return jsonError(400, 'Invalid ElevenLabs endpoint path.')
  }

  const headers = new Headers({ 'xi-api-key': auth.key })
  const contentType = request.headers.get('content-type')
  // Multipart bodies carry a generated boundary in the content-type, so it has
  // to be forwarded verbatim or the upstream cannot parse the form.
  if (contentType) headers.set('content-type', contentType)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

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
      'Could not reach ElevenLabs.',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export const config: Config = {
  path: '/api/elevenlabs/*',
}
