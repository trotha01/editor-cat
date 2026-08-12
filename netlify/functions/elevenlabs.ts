import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { isBlockedHost, jsonError, passthroughHeaders, upstreamPath } from '../lib/proxy'
import { isAllowedWithSiteKey, isAppJob, isDubDeletion, type UpstreamDub } from '../lib/elevenlabs'

/**
 * Proxy to the ElevenLabs API.
 *
 *   GET    /api/elevenlabs/status                          -> is a key provided here?
 *   GET    /api/elevenlabs/v1/voices                        -> list target voices
 *   GET    /api/elevenlabs/v1/models                        -> find a capable model
 *   POST   /api/elevenlabs/v1/speech-to-speech/<voice_id>   -> convert a recording
 *   POST   /api/elevenlabs/v1/dubbing                       -> start fixing a clip
 *   GET    /api/elevenlabs/v1/dubbing/<id>                  -> how it is getting on
 *   GET    /api/elevenlabs/v1/dubbing/resource/<id>         -> its segments and renders
 *   PATCH  .../resource/<id>/segment/<seg>/<lang>           -> put a caption on a segment
 *   POST   .../resource/<id>/speaker/<sp>/segment           -> add one it missed
 *   DELETE .../resource/<id>/segment/<seg>                  -> drop one it invented
 *   PATCH  .../resource/<id>/speaker/<sp>                   -> choose the voice
 *   POST   .../resource/<id>/dub                            -> say them again
 *   POST   .../resource/<id>/render/<lang>                  -> mix the new track
 *   GET    /api/elevenlabs/v1/dubbing/<id>/audio/<lang>     -> bring it back
 *   DELETE /api/elevenlabs/v1/dubbing/<id>                  -> tidy the job away
 *   POST   /api/elevenlabs/v1/forced-alignment              -> find the words in it
 *
 * One key pays for all of it: `ELEVENLABS_API_KEY`, the deployment's own. That
 * is why a visitor needs no key for anything — images, video and captions
 * already run on the site's fal account, and voice runs on the site's ElevenLabs
 * account beside them. Nothing the browser sends is used as a credential, and a
 * caller-supplied `xi-api-key` is ignored rather than forwarded: there is no
 * field left to type one into, so a request carrying one is not a visitor
 * bringing their own account, it is somebody probing what this endpoint will do
 * with a header.
 *
 * Spending the operator's money demands a verified session exactly as
 * `/api/fal` does, and confines the request to the endpoints this app actually
 * calls — see `netlify/lib/elevenlabs.ts`, where each restriction is explained
 * and tested.
 *
 * Multipart bodies (a recording to convert, a clip to dub, a track to align)
 * have to stay under the 6MB function payload ceiling. Conversion sends the
 * recording as it was made — Opus runs about 4KB/s — and a clip travels as mono
 * PCM, which is why the caller refuses to dub one longer than `dubbableSeconds`
 * in `src/lib/clipAudioFix.ts`. That constant is this limit, in seconds.
 */

const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io'

function siteKey(): string {
  return (process.env.ELEVENLABS_API_KEY ?? '').trim()
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Whether this deployment provides a key.
 *
 * Answered without a session, and it discloses nothing but a boolean the UI is
 * about to act on anyway: whether the voice features are offered at all, or
 * whether the visitor is asked for a key of their own first. A route that
 * demanded a token here would leave a signed-out browser unable to tell "not set
 * up" from "not signed in yet", which are different sentences on screen.
 */
function status(): Response {
  return json({ configured: siteKey().length > 0 })
}

/**
 * Says a status came from ElevenLabs rather than from this function.
 *
 * They collide on exactly the code that matters most. This proxy answers 401
 * when the caller has no valid session, and ElevenLabs answers 401 when the
 * *site's* key is refused — a revoked key, or a workspace without access to a
 * closed-beta API. Passed through bare, the second one reaches the browser
 * looking like the first, and the user is told to sign in again about something
 * signing in cannot touch. That happened, with dubbing's resource endpoints.
 */
const UPSTREAM_STATUS_HEADER = 'x-elevenlabs-status'

/** Straight to ElevenLabs with whichever key won, and back out again. */
async function forward(
  target: URL,
  method: string,
  key: string,
  request: Request,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  const headers = new Headers({ 'xi-api-key': key })
  const contentType = request.headers.get('content-type')
  // Multipart bodies carry a generated boundary in the content-type, so it has
  // to be forwarded verbatim or the upstream cannot parse the form.
  if (contentType) headers.set('content-type', contentType)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

  return await fetch(target, { method, headers, body })
}

/**
 * Refuses to delete a dubbing project this app did not make.
 *
 * The id comes from the browser, and on the site's key it addresses every job in
 * the operator's account — including ones made by hand in Dubbing Studio, which
 * are somebody's afternoon rather than a throwaway. So the name is read first
 * and has to say this was one of ours. A job that has already gone is let
 * through: the caller is tidying up after itself and the outcome it wants has
 * happened.
 */
async function mayDeleteDub(key: string, path: string): Promise<boolean> {
  const id = path.slice('v1/dubbing/'.length)
  const found = await fetch(`${ELEVENLABS_ORIGIN}/v1/dubbing/${encodeURIComponent(id)}`, {
    headers: { 'xi-api-key': key },
  })
  if (found.status === 404) return true
  if (!found.ok) return false

  const dub = (await found.json()) as UpstreamDub
  return isAppJob(dub.name)
}

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const path = upstreamPath(url.pathname, '/api/elevenlabs')
  const method = request.method.toUpperCase()

  if (path === 'status') {
    return method === 'GET' ? status() : jsonError(405, 'Use GET for the status route.')
  }

  if (!path) return jsonError(400, 'Missing ElevenLabs endpoint path.')

  const target = new URL(`${ELEVENLABS_ORIGIN}/${path}`)
  target.search = url.search

  // The path is attacker-controllable, so confirm it did not escape the origin
  // before any key is attached to it.
  if (target.origin !== ELEVENLABS_ORIGIN || isBlockedHost(target.hostname)) {
    return jsonError(400, 'Invalid ElevenLabs endpoint path.')
  }

  const key = siteKey()
  if (!key) {
    return jsonError(
      503,
      'This site is not set up for voice generation.',
      "Set ELEVENLABS_API_KEY in the site's environment variables.",
    )
  }

  const session = await requireSession(request)
  if (!session.ok) return session.response

  if (!isAllowedWithSiteKey(method, path)) {
    return jsonError(
      403,
      'That ElevenLabs endpoint is not reachable through this site.',
      'Only the calls this editor makes are forwarded on the site’s key.',
    )
  }
  if (isDubDeletion(method, path) && !(await mayDeleteDub(key, path))) {
    return jsonError(
      403,
      'That dubbing job was not created by this site, so it will not be deleted through here.',
    )
  }

  const hasBody = method !== 'GET' && method !== 'HEAD'

  try {
    const body = hasBody ? await request.arrayBuffer() : undefined
    const upstream = await forward(target, method, key, request, body)

    const headers = passthroughHeaders(upstream.headers)
    headers.set(UPSTREAM_STATUS_HEADER, String(upstream.status))
    return new Response(upstream.body, { status: upstream.status, headers })
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
