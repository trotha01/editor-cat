/**
 * Who Netlify Identity says a caller is.
 *
 * Netlify signs Identity tokens with a secret that is never exposed to the site,
 * so this side cannot verify one locally the way it verifies the tokens it mints
 * itself. The only authority is GoTrue: `GET /.netlify/identity/user` answers
 * with the account behind a token, or 401.
 *
 * That is a round trip, which is why nothing on a hot path does it. Only
 * `/api/session` asks — once, to mint the hour-long token that everything else
 * actually carries and that `auth.ts` verifies without leaving the process. A
 * video job polling for minutes must not become minutes of requests to Netlify's
 * identity service.
 */

/**
 * Where this site's Identity instance lives.
 *
 * Derived from the request by default, because Identity is served from the same
 * origin as the function asking about it — the same reasoning as `redirectUri`
 * in googleOauth.ts, and the same escape hatch for a proxy that rewrites the
 * host in front of the site. `IDENTITY_ENDPOINT` is Netlify's own name for it
 * and is accepted where it happens to be set.
 */
export function identityUrl(requestUrl: string): string {
  const configured = (
    process.env.NETLIFY_IDENTITY_URL ??
    process.env.IDENTITY_ENDPOINT ??
    ''
  ).trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `${new URL(requestUrl).origin}/.netlify/identity`
}

export interface IdentityUser {
  id: string
  email: string
}

/**
 * Raised when Identity could not be asked, as opposed to answering "no".
 *
 * Kept apart from a plain `null` because the two mean opposite things to the
 * caller: a token Identity rejected is the visitor's problem and answers 401,
 * while an Identity that did not answer at all is ours and answers 502. Merging
 * them would tell someone to sign in again during an outage that signing in
 * again cannot fix.
 */
export class IdentityUnavailableError extends Error {
  constructor(detail: string) {
    super(`Could not reach Netlify Identity: ${detail}`)
    this.name = 'IdentityUnavailableError'
  }
}

/** Beyond this it is not a diagnostic any more, it is a payload. */
const DETAIL_LIMIT = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The account behind an Identity token, or null when Identity refuses it.
 *
 * A user with no id is treated as no user at all: the id is the key everything
 * this app stores is filed under, and a row keyed on `undefined` is worse than a
 * refused sign-in.
 */
export async function identityUser(
  token: string,
  requestUrl: string,
): Promise<IdentityUser | null> {
  const endpoint = `${identityUrl(requestUrl)}/user`

  let response: Response
  try {
    response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })
  } catch (cause) {
    throw new IdentityUnavailableError(
      (cause instanceof Error ? cause.message : String(cause)).slice(0, DETAIL_LIMIT),
    )
  }

  // GoTrue answers 401 for a token it will not accept, which is an answer.
  if (response.status === 401 || response.status === 403) return null
  if (!response.ok) {
    throw new IdentityUnavailableError(`${endpoint} answered ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A site with Identity switched off has no such endpoint, and the SPA
    // fallback serves index.html with a cheerful 200. That is not a user.
    throw new IdentityUnavailableError(`${endpoint} did not answer with JSON`)
  }

  if (!isRecord(body) || typeof body.id !== 'string' || !body.id) return null

  return { id: body.id, email: typeof body.email === 'string' ? body.email : '' }
}
