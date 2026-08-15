/**
 * Where a caller's objects are allowed to live, and nowhere else.
 *
 * R2 has no row-level security. Supabase refuses a write to somebody else's
 * folder itself — Mintspace's storage policy checks
 * `(storage.foldername(name))[1] = auth.uid()` and the database says no. There
 * is no equivalent here: a presigned URL is simply valid, and the only thing
 * standing between one account and another's files is that **this module
 * computes every prefix from a verified token and the endpoint never accepts
 * one from the client**. That is the whole security model, which is why it
 * lives in one small file with its own tests rather than inline in the handler.
 *
 * Two prefix schemes, because two different identities own the two buckets:
 *
 *  - **Published feed videos** are keyed by the *Mintspace* account id. That is
 *    deliberate and not merely convenient. The feed row is owned by a Mintspace
 *    uid, and if the objects were keyed by the Auth0 subject instead, one
 *    Mintspace account reached from two Auth0 sign-ins would scatter its videos
 *    across two prefixes — and a delete would remove the row, find nothing under
 *    the prefix it derived, and report success over an orphaned set of files.
 *    Today one session authorises both halves and that cannot happen; keying by
 *    the Mintspace uid is what keeps it that way. It is not hashed because it is
 *    already public — the feed selects `user_id` on every card.
 *  - **Generated media and word takes** are keyed by a hash of the Auth0
 *    subject. These URLs are presigned rather than public, and a raw subject
 *    (`google-oauth2|104372…`) has no business appearing in a key at all.
 */

/**
 * Object-name charset. No slashes, nothing to reinterpret.
 *
 * The leading character must be alphanumeric, which is what rules out `.` and
 * `..`. Those pass any charset test that allows dots at all, and they matter
 * here for a reason that is easy to miss: S3 keys are opaque strings, so R2
 * would happily store an object literally named `..` — but the playlist refers
 * to its segments by *relative* URI, and a browser resolving
 * `https://cdn/v1/uid/pub/..` walks up a directory. A key that is harmless in
 * the store is not automatically harmless in the player.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Id charset, for publication and asset ids. Deliberately excludes dots. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Above this, a request is not a video — it is a mistake or an attack.
 *
 * A ten-minute export at four-second segments is about 150 objects, so 512
 * leaves generous headroom while keeping a teardown inside the function's
 * ten-second budget.
 */
export const MAX_OBJECTS_PER_REQUEST = 512

/** No single object may exceed this. Roughly a long 1080p export. */
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024

/** Nor may one request's objects together. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024 * 1024

/**
 * What may be stored, per scope.
 *
 * Pinned into the upload signature, so this list is enforced by R2 rather than
 * merely checked here. The reason it is a list at all is that the public bucket
 * sits on a domain of ours: an upload URL that would accept `text/html` is a
 * way to host somebody's page under our own name.
 */
export const PUBLICATION_CONTENT_TYPES = [
  'video/mp4',
  'video/iso.segment',
  'application/vnd.apple.mpegurl',
  'image/jpeg',
] as const

export const ASSET_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
] as const

export type Scope = 'publication' | 'asset'

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name)
}

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id)
}

export function allowedContentTypes(scope: Scope): readonly string[] {
  return scope === 'publication' ? PUBLICATION_CONTENT_TYPES : ASSET_CONTENT_TYPES
}

export function isAllowedContentType(scope: Scope, contentType: string): boolean {
  return allowedContentTypes(scope).includes(contentType)
}

/**
 * A stable, non-reversible stand-in for an Auth0 subject.
 *
 * Truncated to 32 hex characters: 128 bits of a SHA-256, which is far past any
 * collision worth worrying about for a per-user namespace, and short enough to
 * keep keys readable in a bucket listing.
 */
export async function hashSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

/**
 * Where one published video's objects live.
 *
 * `v1/` is a schema marker, not a version of the video. If the layout ever has
 * to change, old prefixes keep resolving and new ones move — which matters more
 * than usual here, because these keys are baked into feed rows that outlive any
 * deploy.
 */
export function publicationPrefix(mintspaceUid: string, publicationId: string): string {
  return `v1/${mintspaceUid}/${publicationId}/`
}

/** Where one account's generated media and word takes live. */
export function assetPrefix(subjectHash: string): string {
  return `asset/${subjectHash}/`
}

export type PrefixResult = { ok: true; prefix: string } | { ok: false; reason: string }

/**
 * The prefix a publication upload or teardown may touch.
 *
 * Both ids are validated even though one comes from a verified token: a
 * Mintspace uid is a uuid in practice, but "in practice" is not a check, and
 * this string is about to become a path segment.
 */
export function publicationPrefixFor(mintspaceUid: string, publicationId: string): PrefixResult {
  if (!isSafeId(mintspaceUid)) {
    return { ok: false, reason: 'That Mintspace account id is not a shape we store under.' }
  }
  if (!isSafeId(publicationId)) {
    return { ok: false, reason: 'That publication id is not a shape we store under.' }
  }
  return { ok: true, prefix: publicationPrefix(mintspaceUid, publicationId) }
}

/**
 * Validates the names a caller wants to write under a prefix, and returns the
 * full keys.
 *
 * Names rather than keys on purpose: the caller says `seg00001.m4s`, never
 * `v1/…/seg00001.m4s`. There is no syntax in which a client can express a path,
 * so there is nothing to escape and nothing to normalise — the one job here is
 * to refuse anything that is not a bare, boring filename.
 */
export function keysUnder(
  prefix: string,
  names: string[],
):
  | { ok: true; keys: string[] }
  | {
      ok: false
      reason: string
    } {
  if (names.length === 0) {
    return { ok: false, reason: 'No objects were named.' }
  }
  if (names.length > MAX_OBJECTS_PER_REQUEST) {
    return {
      ok: false,
      reason: `That is more than ${MAX_OBJECTS_PER_REQUEST} objects in one request.`,
    }
  }

  const seen = new Set<string>()
  for (const name of names) {
    if (typeof name !== 'string' || !isSafeName(name)) {
      return { ok: false, reason: `"${String(name).slice(0, 64)}" is not a name we will store.` }
    }
    if (seen.has(name)) {
      return { ok: false, reason: `"${name}" was named twice.` }
    }
    seen.add(name)
  }

  return { ok: true, keys: names.map((name) => `${prefix}${name}`) }
}

/**
 * Whether a key the caller handed back is one they were ever given.
 *
 * Used on the read and delete paths, where the client does name keys — it is
 * echoing back what an upload returned. Belt and braces over the prefix
 * derivation rather than a substitute for it.
 */
export function isUnderPrefix(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false
  const rest = key.slice(prefix.length)
  // No nesting and no traversal: everything we write is one flat level down.
  return isSafeName(rest)
}

/**
 * The same question against a set of prefixes.
 *
 * A caller has more than one once word shelves can be shared: their own, and
 * one per person they share a shelf with. The set is still derived here from
 * subjects the caller was proved entitled to — see netlify/lib/shelfShares.ts —
 * so the sentence at the top of this file is unchanged, only pluralised.
 */
export function isUnderAnyPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isUnderPrefix(key, prefix))
}

/** The asset prefix for each of a set of subjects. */
export async function assetPrefixesFor(subjects: readonly string[]): Promise<string[]> {
  return await Promise.all(subjects.map(async (subject) => assetPrefix(await hashSubject(subject))))
}
