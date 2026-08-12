/**
 * Shared helpers for the bring-your-own-key proxy functions.
 *
 * This lives in netlify/lib/ rather than alongside the handlers on purpose:
 * Netlify treats *every* file in the functions directory as a deployable
 * function, so a helper there becomes a pointless endpoint and a test file
 * there fails the deploy outright ("_shared.test" is not a legal function
 * name). Keep netlify/functions/ to handlers only; esbuild bundles imports
 * from here into each one.
 *
 * Provider keys belong to the deployment: fal and ElevenLabs are both read from
 * the environment and never reach the browser at all. See `requireServerKey`,
 * and `auth.ts` for who is allowed to spend one.
 *
 * ElevenLabs additionally accepts a key the caller brought, which takes
 * precedence over the site's own — someone who would rather use their own quota
 * and their own voice library can. That choice is made in the handler rather
 * than here, deliberately: a shared helper that quietly substituted the site's
 * credentials for a missing header would be a security surprise buried where
 * nobody reviewing an endpoint would look for it.
 *
 * Routing through our own origin is what makes either kind reliable: we do not
 * depend on each provider's CORS policy (which we cannot control and which
 * changes without notice), and provider media arrives same-origin so it never
 * taints the export canvas.
 *
 * Invariants worth keeping:
 *  - no key is ever written to storage or to a log line
 *  - only allowlisted upstream hosts are reachable (SSRF guard)
 *  - responses stream through rather than buffering, to stay under the
 *    6MB function payload ceiling wherever possible
 */

/** Hosts the media proxy is allowed to fetch from. Suffix match on the hostname. */
export const MEDIA_HOST_ALLOWLIST = ['fal.media', 'fal.run', 'fal.ai', 'elevenlabs.io'] as const

/** Header names that must never appear in a log line. */
const SECRET_HEADERS = new Set(['authorization', 'xi-api-key', 'x-fal-key', 'cookie'])

export function jsonError(status: number, message: string, detail?: unknown): Response {
  return new Response(JSON.stringify({ error: message, detail: detail ?? null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * True if the hostname is an IP literal or name that could reach the host
 * network, cloud metadata, or another internal service. Checked in addition to
 * the allowlist as defence in depth — an allowlisted domain that resolves to a
 * private address should still be refused.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '0.0.0.0') return true

  // IPv4 literals in private, loopback, link-local, or unspecified ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }

  // IPv6 unique-local and link-local.
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true

  return false
}

export function isAllowedMediaUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'Not a valid absolute URL.' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https URLs may be fetched.' }
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: 'That host is not reachable through this proxy.' }
  }

  const host = url.hostname.toLowerCase()
  const allowed = MEDIA_HOST_ALLOWLIST.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
  if (!allowed) {
    return {
      ok: false,
      reason: `Host "${host}" is not on the media allowlist. Allowed: ${MEDIA_HOST_ALLOWLIST.join(', ')}.`,
    }
  }

  return { ok: true, url }
}

/**
 * Copies through the headers a provider response needs, dropping hop-by-hop
 * headers and anything that would let the upstream set cookies on our origin.
 */
export function passthroughHeaders(upstream: Headers): Headers {
  const out = new Headers()
  const keep = [
    'content-type',
    'content-length',
    'content-disposition',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
  ]
  for (const name of keep) {
    const value = upstream.get(name)
    if (value) out.set(name, value)
  }
  return out
}

/** Redacts secrets so a header set can be safely logged while debugging. */
export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value
  })
  return out
}

/**
 * Reads a provider key this deployment owns, rather than one the caller sent.
 *
 * Used where the site pays the provider itself. A missing variable is an
 * operator mistake that no visitor can do anything about, so it answers 503
 * naming the variable rather than 401 telling someone to check their settings.
 */
export function requireServerKey(
  name: string,
  label: string,
): { ok: true; key: string } | { ok: false; response: Response } {
  const key = (process.env[name] ?? '').trim()
  if (!key) {
    return {
      ok: false,
      response: jsonError(
        503,
        `This site is not configured for ${label}.`,
        `Set ${name} in the site's environment variables.`,
      ),
    }
  }
  return { ok: true, key }
}

/** Strips a leading proxy mount point off a pathname, returning the upstream path. */
export function upstreamPath(pathname: string, mount: string): string {
  const rest = pathname.startsWith(mount) ? pathname.slice(mount.length) : pathname
  return rest.replace(/^\/+/, '')
}
