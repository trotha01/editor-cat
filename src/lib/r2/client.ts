/**
 * Where published media is served from.
 *
 * One value, and it is not a secret: the Cloudflare custom domain bound to the
 * public R2 bucket, which is the origin every feed URL is built on and is
 * therefore in every card the feed draws.
 *
 * Read lazily rather than at module load, the same way the Supabase and
 * Mintspace clients do it, so a deployment with no R2 behind it still imports
 * this file to ask whether there is one.
 */

function base(): string {
  return import.meta.env.VITE_R2_PUBLIC_BASE?.trim().replace(/\/+$/, '') ?? ''
}

/** Whether this deployment has somewhere to publish to. */
export function isR2Configured(): boolean {
  return base().length > 0
}

/**
 * The public URL of an object in the media bucket.
 *
 * Built from the key the upload endpoint returned rather than assembled here
 * from parts: the key is derived server-side from a verified token, and
 * rebuilding it in the browser would put the prefix scheme in two places, where
 * the wrong one would eventually win.
 */
export function publicUrl(key: string): string {
  if (!isR2Configured()) {
    throw new Error('This site is not set up for media storage: set VITE_R2_PUBLIC_BASE.')
  }
  return `${base()}/${key.replace(/^\/+/, '')}`
}
