/**
 * Putting a deploy back on the domain its URLs were meant to be on.
 *
 * Netlify's automatic deploy subdomains give every deploy a host under a domain
 * you own — `deploy-preview-32.staging.example.com` — but they do not retire the
 * `deploy-preview-32--sitename.netlify.app` one. That stays live, and it stays
 * *canonical*, which is the part that matters here: Netlify Identity redirects
 * to canonical after a Google sign-in, so whoever signs in arrives on the
 * netlify.app host no matter which one they started from.
 *
 * There is nothing to configure away. `gotrue-js` sends no return address —
 * `loginExternalUrl` is `/authorize?provider=…` and nothing else — and Netlify's
 * hosted GoTrue overrides the referrer it would otherwise fall back on with the
 * deploy's own URL.
 *
 * Which would be a cosmetic annoyance if the host did not decide what Google
 * will allow. It does: a redirect URI takes no wildcard at all, and `*.netlify.app`
 * in an API key's referrer list means every site Netlify hosts rather than this
 * one. A domain you own can be allowlisted precisely; a shared one cannot. So a
 * deploy that finds itself on the wrong host leaves for the right one before
 * anything has read the address.
 *
 * The move happens before the sign-in is adopted, and carries the fragment with
 * it, because that fragment *is* the sign-in — Identity returns its tokens
 * there. See `consumeIdentityRedirect` in ./identity.ts, which then reads them
 * on the far side and files the session under the origin that will be using it.
 */

const NETLIFY_SUFFIX = '.netlify.app'

/**
 * The domain deploy subdomains hang off, or null for a site without them.
 *
 * Unset is the ordinary case and means no relocation ever happens: a site whose
 * deploys share one URL, `netlify dev`, and production, whose own domain Netlify
 * already redirects to.
 */
function deployDomain(): string | null {
  const configured = import.meta.env.VITE_NETLIFY_DEPLOY_DOMAIN?.trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  return configured || null
}

/**
 * Where `href` should be instead, or null when it is already right.
 *
 * Split at the *last* `--`, not the first: a site name may not contain one — the
 * delimiter would be ambiguous if it could — but a slugified branch name may, so
 * that is the half that has to give.
 *
 * A netlify.app host with no `--` in it is the site's own address rather than a
 * deploy's, and has no subdomain form to move to.
 */
export function relocatedUrl(href: string, domain: string | null): string | null {
  if (!domain) return null

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  if (!host.endsWith(NETLIFY_SUFFIX)) return null

  const site = host.slice(0, -NETLIFY_SUFFIX.length)
  const boundary = site.lastIndexOf('--')
  if (boundary < 0) return null

  const deploy = site.slice(0, boundary)
  if (!deploy) return null

  url.hostname = `${deploy}.${domain}`
  return url.toString()
}

/**
 * Moves this document to the deploy domain, and says whether it is leaving.
 *
 * `replace` rather than `assign`: the address being left is not a page anyone
 * should be able to go back to, and a back button that returns to a host which
 * immediately leaves again is a trap rather than a history entry.
 *
 * A caller that gets `true` should do nothing further. The navigation is not
 * instant, and whatever runs in the meantime runs on a host this document has
 * already decided it should not be on.
 */
export function relocateToDeployDomain(href: string = window.location.href): boolean {
  const target = relocatedUrl(href, deployDomain())
  if (!target) return false

  window.location.replace(target)
  return true
}
