import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { isBlockedHost, jsonError, passthroughHeaders, upstreamPath } from '../lib/proxy'
import {
  isAllowedWithSiteKey,
  isAppClone,
  isCloneRequest,
  isVoiceDeletion,
  isVoiceLimitError,
  staleClones,
  type UpstreamVoice,
} from '../lib/elevenlabs'

/**
 * Proxy to the ElevenLabs API.
 *
 *   GET    /api/elevenlabs/status                        -> is a key provided here?
 *   GET    /api/elevenlabs/v1/voices                      -> list target voices
 *   GET    /api/elevenlabs/v1/models                      -> find a capable model
 *   POST   /api/elevenlabs/v1/text-to-speech/<voice_id>   -> say a line
 *   POST   /api/elevenlabs/v1/speech-to-speech/<voice_id> -> convert a recording
 *   POST   /api/elevenlabs/v1/voices/ivc/create           -> copy a voice
 *   DELETE /api/elevenlabs/v1/voices/<voice_id>           -> delete that copy again
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
 * Multipart bodies (a recording to convert, a sample to clone from) have to stay
 * under the 6MB function payload ceiling. Conversion sends the recording as it
 * was made — Opus runs about 4KB/s — and a cloning sample is capped at thirty
 * seconds by the caller, which is well inside it.
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
 * Deletes clones nobody can still be using, and says how many went.
 *
 * Only ever called when a clone has just been refused for want of a slot: this
 * is the operator's own voice library, and tidying it is not something to do on
 * a request that was going to succeed anyway.
 */
async function sweepAbandonedClones(key: string, nowMs: number): Promise<number> {
  const listed = await fetch(`${ELEVENLABS_ORIGIN}/v1/voices`, { headers: { 'xi-api-key': key } })
  if (!listed.ok) return 0

  const body = (await listed.json()) as { voices?: UpstreamVoice[] }
  const ids = staleClones(body.voices ?? [], nowMs)

  let removed = 0
  for (const id of ids) {
    const gone = await fetch(`${ELEVENLABS_ORIGIN}/v1/voices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': key },
    })
    if (gone.ok) removed += 1
  }
  if (removed > 0) {
    console.warn(`[elevenlabs] Swept ${removed} abandoned voice clone(s) from the site account.`)
  }
  return removed
}

/**
 * Refuses to delete a voice this app did not make.
 *
 * The id comes from the browser, and on the site's key it addresses the
 * operator's whole library — so the name is read first and has to say this was
 * one of ours. A voice that has already gone is let through: the caller is
 * tidying up after itself and the outcome it wants has happened.
 */
async function mayDelete(key: string, path: string): Promise<boolean> {
  const id = path.slice('v1/voices/'.length)
  const found = await fetch(`${ELEVENLABS_ORIGIN}/v1/voices/${encodeURIComponent(id)}`, {
    headers: { 'xi-api-key': key },
  })
  if (found.status === 404) return true
  if (!found.ok) return false

  const voice = (await found.json()) as UpstreamVoice
  return isAppClone(voice.name)
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
  if (isVoiceDeletion(method, path) && !(await mayDelete(key, path))) {
    return jsonError(
      403,
      'That voice was not created by this site, so it will not be deleted through here.',
    )
  }

  const hasBody = method !== 'GET' && method !== 'HEAD'

  try {
    const body = hasBody ? await request.arrayBuffer() : undefined
    const upstream = await forward(target, method, key, request, body)

    // A clone refused for want of a slot is the one failure worth answering
    // rather than reporting: the library filled up with this app's own
    // leftovers, so it is cleared of the abandoned ones and the request is
    // given its second and only chance. Buffered rather than streamed here
    // because deciding that means reading the message.
    if (!upstream.ok && isCloneRequest(method, path)) {
      const detail = await upstream.text()
      if (isVoiceLimitError(detail) && (await sweepAbandonedClones(key, Date.now())) > 0) {
        const retried = await forward(target, method, key, request, body)
        return new Response(retried.body, {
          status: retried.status,
          headers: passthroughHeaders(retried.headers),
        })
      }
      // Rebuilt from text rather than streamed, so the length the upstream
      // declared no longer describes what is being sent. Left in, it is a
      // header that contradicts the body.
      const headers = passthroughHeaders(upstream.headers)
      headers.delete('content-length')
      return new Response(detail, { status: upstream.status, headers })
    }

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
