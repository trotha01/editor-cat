import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { jsonError, requireServerKey } from '../lib/proxy'
import {
  RATE_LIMIT,
  issueBody,
  issueTitle,
  labelsFor,
  parseDraft,
  repoTarget,
  withinRateLimit,
} from '../lib/github'

/**
 * Filing an issue on this deployment's repository, from the report form.
 *
 *   GET  /api/github/status  -> can this deployment file issues, and where to?
 *   POST /api/github/issues  -> file one
 *
 * The token is the deployment's, like the fal key and unlike the ElevenLabs one:
 * a bug report is worth having from someone who has no GitHub account and no
 * intention of getting one, which is most people who hit a bug. That makes this
 * endpoint a button that writes to a public tracker under the operator's name,
 * so it demands the same verified session /api/fal does, caps what it will
 * write, and rate limits per account. The reasoning behind each is in
 * netlify/lib/github.ts, which is also where all of it is tested.
 *
 * The reporter's address is attached from the verified token rather than from
 * the request body — see `Reporter` there. `status` will hand the same address
 * back to a caller that presents a token, so the form can show the person
 * exactly what filing will publish about them before they press anything.
 *
 * The token wants exactly one permission: issues, write, on this one repository.
 * A fine-grained token so scoped can do nothing else if it leaks — it cannot read
 * code, cannot push, and cannot touch another repository.
 */

const GITHUB_API = 'https://api.github.com'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Per-deployment and per-user; nothing in between should hold on to it.
      'cache-control': 'no-store',
    },
  })
}

/**
 * Whether the feature is available, and who a report would be attributed to.
 *
 * The form asks this before it offers to file anything, so that "report a bug"
 * either works or is never offered — collecting a careful report and then
 * discovering there is nowhere to send it wastes the one person in a hundred
 * willing to write one.
 *
 * It answers without a session, because of what the first half discloses: a
 * boolean, and the name of the public repository whose issues this site files.
 * Both are on the screen of any deployment where the feature works.
 *
 * `reporter` is the other half, and it is per-caller: the address this endpoint
 * *would* publish, from their own verified token. A caller who sends no token,
 * or a bad one, is simply told nothing — this route must not turn into a way to
 * find out whether a token is good, and must never 401, or a signed-out browser
 * would be told the feature is broken when it is merely not signed in yet.
 */
async function status(request: Request): Promise<Response> {
  const target = repoTarget()
  const configured = Boolean(target) && Boolean((process.env.GITHUB_TOKEN ?? '').trim())

  return json({
    configured,
    repo: configured && target ? `${target.owner}/${target.repo}` : null,
    reporter: request.headers.get('authorization') ? await verifiedEmail(request) : null,
  })
}

/** The signed-in address, or null for any reason at all. */
async function verifiedEmail(request: Request): Promise<string | null> {
  const session = await requireSession(request)
  return session.ok ? session.email : null
}

async function file(request: Request): Promise<Response> {
  const session = await requireSession(request)
  if (!session.ok) return session.response

  const auth = requireServerKey('GITHUB_TOKEN', 'filing issues')
  if (!auth.ok) return auth.response

  const target = repoTarget()
  if (!target) {
    return jsonError(
      503,
      'This site is not set up for filing issues.',
      "Set GITHUB_REPO to owner/repo in the site's environment variables.",
    )
  }

  // `userId` is null only where the deployment has opted into anonymous access
  // for local development, so one bucket for all of them is right: on such a
  // checkout there is exactly one person.
  if (!withinRateLimit(session.userId ?? 'anonymous')) {
    return jsonError(
      429,
      'That is a lot of reports in a short time. Try again in a few minutes.',
      `Up to ${RATE_LIMIT.max} issues per ${Math.round(RATE_LIMIT.windowMs / 60000)} minutes.`,
    )
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return jsonError(400, 'That report could not be read.', 'The request body was not valid JSON.')
  }

  const parsed = parseDraft(payload)
  if (!parsed.ok) return jsonError(400, 'That report is incomplete.', parsed.reason)

  const draft = parsed.draft

  try {
    const upstream = await fetch(`${GITHUB_API}/repos/${target.owner}/${target.repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.key}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        // GitHub rejects an API request with no user agent outright.
        'user-agent': 'editor-cat',
      },
      body: JSON.stringify({
        title: issueTitle(draft),
        // The address comes from the session, not from `draft` — the browser
        // has no say in whose name a report is filed under.
        body: issueBody(draft, { email: session.email, userId: session.userId }),
        labels: labelsFor(draft.kind),
      }),
    })

    if (!upstream.ok) {
      // GitHub's own message names the repository and the token's permissions,
      // which is operator-shaped detail rather than anything the person who
      // just wrote a bug report can act on. It goes to the function log; they
      // get told it did not work.
      const detail = await upstream.text().catch(() => '')
      console.warn(`[github] Could not file an issue (${upstream.status}): ${detail.slice(0, 500)}`)

      return jsonError(
        upstream.status === 401 || upstream.status === 403 ? 503 : 502,
        'GitHub would not accept that report.',
        'Nothing you can fix from here — the site owner has been left a log line.',
      )
    }

    const created = (await upstream.json()) as { number?: number; html_url?: string }

    return json({ number: created.number ?? null, url: created.html_url ?? null }, 201)
  } catch (error) {
    return jsonError(
      502,
      'Could not reach GitHub.',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export default async (request: Request): Promise<Response> => {
  const route = new URL(request.url).pathname.replace(/^\/api\/github\/?/, '').replace(/\/+$/, '')

  if (route === 'status' && request.method === 'GET') return await status(request)
  if (route === 'issues' && request.method === 'POST') return file(request)

  return jsonError(404, 'No such endpoint.')
}

export const config: Config = {
  path: '/api/github/*',
}
