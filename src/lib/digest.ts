/**
 * A content hash, for telling one export from the same export again.
 *
 * Publishing to Mintspace records the digest of what went up, so pressing the
 * button twice on an unchanged project can be recognised as the duplicate it is
 * rather than posted twice. A hash rather than a comparison of settings because
 * settings are not what a viewer sees: two renders at the same resolution and
 * quality are different videos if a clip moved between them, and identical ones
 * if nothing did.
 */

/**
 * SHA-256 of a blob, as lowercase hex, or null when this browser will not.
 *
 * `crypto.subtle` exists only in a secure context — https, or localhost. A page
 * served over plain http therefore has no digest available, and null is how
 * that is said: the caller falls back to asking the user rather than refusing
 * to publish over a hash it could not take. Anything else thrown is treated the
 * same way, since none of it is worth failing an export for.
 */
export async function sha256Hex(blob: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null

  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}
