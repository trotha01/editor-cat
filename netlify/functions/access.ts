import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { jsonError } from '../lib/proxy'

/**
 * Whether this account may use this deployment.
 *
 *   GET /api/access  ->  200 when the session is allowed, 403 when it is not
 *
 * The same question every other endpoint asks before it spends anything, asked
 * on its own so the editor can ask it once at the door. Without this the answer
 * would only arrive as a refusal from whichever button the person pressed
 * first — a stranger let all the way into the editor, given a project and a
 * Drive prompt, and then told no by a generate button. Being turned away is
 * fine; being turned away four screens in is not.
 *
 * It is the same `requireSession` the proxies use rather than a second opinion
 * about the same list, so it cannot drift into agreeing when they would refuse.
 * That also means nothing here has to be reviewed for who is allowed: this
 * route is a mirror, and `netlify/lib/allowlist.ts` is the answer.
 */

export default async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') return jsonError(405, 'Use GET.')

  const session = await requireSession(request)
  if (!session.ok) return session.response

  return new Response(JSON.stringify({ allowed: true, email: session.email }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const config: Config = {
  path: '/api/access',
}
