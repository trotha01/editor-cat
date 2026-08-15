/**
 * Fetching an asset's bytes back out of the private bucket.
 *
 * These objects are not public and not behind the CDN. Every read is a
 * short-lived presigned GET, which is the right trade for something fetched
 * once per device and then kept in IndexedDB: a signed URL is unique per issue,
 * so it would miss cache every time anyway, and in exchange somebody's source
 * footage is not readable by anyone who guesses a key.
 *
 * A presigned URL is a credential with an expiry, so it is derived on demand
 * and never stored. Caching one in IndexedDB beside the asset would be a
 * stale-auth bug waiting for a slow week.
 */
import { auth0IdToken, auth0Token } from '../auth0/client'
import { mapLimited } from '../concurrency'

/** Signed for long enough that a large take on a slow line still finishes. */
const SIGN_BATCH = 64

/**
 * Both tokens, because a key on a shared shelf is not settled by either alone.
 *
 * `authorization` is the access token, minted for this site's API, and it is
 * what proves who is asking. `x-supabase-authorization` is the ID token, which
 * is the one Supabase accepts — the endpoint uses it to ask the database which
 * shelves this account is on, as this account, rather than holding a
 * service-role key that could ask about anybody. See netlify/lib/shelfShares.ts
 * for why the second one cannot be substituted for the first.
 *
 * A failure to produce the ID token is not a failure to download: the endpoint
 * only consults it for a key that is not the caller's own, which is the
 * uncommon case, and it answers plainly when it needed one and had none.
 */
async function tokens(): Promise<Record<string, string>> {
  const [access, id] = await Promise.all([
    auth0Token().catch(() => null),
    auth0IdToken().catch(() => null),
  ])
  return {
    ...(access ? { authorization: `Bearer ${access}` } : {}),
    ...(id ? { 'x-supabase-authorization': `Bearer ${id}` } : {}),
  }
}

async function sign(keys: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const auth = await tokens()
  const urls = new Map<string, string>()

  // Batched rather than one request per key: hydrating a project asks for every
  // asset at once, and a round trip each would be the slowest part of opening
  // it on a new machine.
  for (let index = 0; index < keys.length; index += SIGN_BATCH) {
    const batch = keys.slice(index, index + SIGN_BATCH)
    const response = await fetch('/api/r2/downloads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth,
      },
      signal,
      body: JSON.stringify({ keys: batch }),
    })

    if (!response.ok) {
      let reason = String(response.status)
      try {
        const body = (await response.json()) as { error?: string }
        if (body.error) reason = body.error
      } catch {
        /* keep the status */
      }
      throw new Error(`Could not reach your stored media: ${reason}`)
    }

    const body = (await response.json()) as { urls: { key: string; url: string }[] }
    for (const entry of body.urls) urls.set(entry.key, entry.url)
  }

  return urls
}

/**
 * One asset's bytes.
 *
 * Signs, fetches, and signs again once if the URL had gone stale. That retry is
 * not defensive padding: hydration signs every key up front and then downloads
 * them a few at a time, so the last file in a large project can be reached for
 * well after its URL was minted.
 */
export async function downloadAsset(key: string, signal?: AbortSignal): Promise<Blob> {
  const first = await sign([key], signal)
  const url = first.get(key)
  if (!url) throw new Error('That file is no longer in storage.')

  let response = await fetch(url, { signal })

  if (response.status === 403) {
    const again = await sign([key], signal)
    const fresh = again.get(key)
    if (fresh) response = await fetch(fresh, { signal })
  }

  if (!response.ok) {
    throw new Error(`Could not download that file (${response.status}).`)
  }

  return await response.blob()
}

/** Several assets, a few at a time. */
export async function downloadAssets(
  keys: string[],
  concurrency = 4,
  signal?: AbortSignal,
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  await mapLimited(keys, concurrency, async (key) => {
    out.set(key, await downloadAsset(key, signal))
  })
  return out
}
