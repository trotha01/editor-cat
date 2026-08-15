/**
 * Signing requests to Cloudflare R2.
 *
 * R2 is the origin for two quite different things, which is why there are two
 * buckets rather than one:
 *
 *  - the **public** bucket holds published feed videos. It is bound to a
 *    Cloudflare custom domain, so the CDN serves it and nothing here signs a
 *    read. That is the whole point of the move: a view costs no egress, and an
 *    immutable key behind a year-long cache rule is served from the edge.
 *  - the **private** bucket holds generated media and word-shelf takes. It has
 *    no domain, and every read is a short-lived presigned GET. Those URLs are
 *    unique per issue and therefore miss cache by design, which is fine —
 *    they are fetched once per device and then live in IndexedDB.
 *  - the **training** bucket holds LoRA training sets: a few hundred photos
 *    uploaded in one sitting and then handed to a trainer, rather than anything
 *    this app plays back. It is optional, and a deployment without it keeps
 *    every other feature — which is why it is the one bucket whose absence does
 *    not make `r2Config()` null.
 *
 * Signing is `aws4fetch` rather than hand-rolled. The precedent next door in
 * auth0.ts is JWT *verification*, where both ends are ours and a mistake fails
 * loudly on the next request; a signing mistake fails as an opaque 403 at best
 * and as a hole at worst. The fiddly parts here — RFC3986 path encoding that
 * leaves `/` alone, query-parameter ordering, the HMAC chain — are exactly what
 * a four-kilobyte audited library is for.
 *
 * Nothing in this module decides *what* a caller may write. Key prefixes are
 * derived from verified tokens in functions/r2.ts, and this file takes the key
 * it is given. Keep it that way: a helper that accepted a prefix from anywhere
 * would put the security model in two places, and the looser one would win.
 */
import { AwsClient, AwsV4Signer } from 'aws4fetch'

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  publicBucket: string
  privateBucket: string
  /**
   * Where training sets go, or null where this deployment has not made one.
   *
   * Nullable rather than required because it arrived long after the other two
   * and buys a single page: a site that never sets it should lose the training
   * uploader and nothing else, not stop storing media altogether.
   */
  trainingBucket: string | null
}

/** Which of the buckets an operation is against. */
export type BucketKind = 'public' | 'private' | 'training'

/**
 * R2 has no regions to choose between, and its S3 endpoint wants this exact
 * string. Signing with anything else fails the signature rather than routing
 * somewhere unexpected.
 */
const REGION = 'auto'
const SERVICE = 's3'

/** Presigned PUTs are used immediately by the browser that asked for one. */
export const UPLOAD_EXPIRY_SECONDS = 15 * 60

/**
 * Presigned GETs are longer because of what they are spent on: a word take on a
 * slow connection is a large file, and a URL that expires mid-download turns a
 * slow morning into a failed one. Fifteen minutes is the floor; the download
 * path re-presigns on a 403 rather than treating it as fatal.
 */
export const DOWNLOAD_EXPIRY_SECONDS = 15 * 60

/**
 * The deployment's R2 credentials, or null when this site has no R2 behind it.
 *
 * Null rather than throwing, and shaped like `auth0Config()` next door: a
 * deployment without R2 should degrade feature by feature and say so, not fail
 * at import time. Every value is read unprefixed — a `VITE_` form would inline
 * the secret into the browser bundle, which is the one mistake this whole file
 * exists downstream of.
 */
export function r2Config(): R2Config | null {
  const accountId = (process.env.R2_ACCOUNT_ID ?? '').trim()
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? '').trim()
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? '').trim()
  const publicBucket = (process.env.R2_BUCKET_PUBLIC ?? '').trim()
  const privateBucket = (process.env.R2_BUCKET_PRIVATE ?? '').trim()
  const trainingBucket = (process.env.R2_BUCKET_TRAINING ?? '').trim()

  if (!accountId || !accessKeyId || !secretAccessKey || !publicBucket || !privateBucket) {
    return null
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    publicBucket,
    privateBucket,
    trainingBucket: trainingBucket || null,
  }
}

/** The bucket a kind names, or null where this deployment has not set one up. */
export function bucketName(config: R2Config, kind: BucketKind): string | null {
  if (kind === 'public') return config.publicBucket
  if (kind === 'private') return config.privateBucket
  return config.trainingBucket
}

/**
 * The bucket a kind names, or a throw.
 *
 * Only the training bucket can be missing, and the endpoint answers 503 for it
 * before anything here is reached — so this is the assertion that keeps that
 * check honest rather than a path anyone is expected to take. Signing against a
 * bucket named `undefined` would fail as an opaque 403 much further away.
 */
function requireBucket(config: R2Config, kind: BucketKind): string {
  const bucket = bucketName(config, kind)
  if (!bucket) {
    throw new Error(`This site has no ${kind} bucket: set R2_BUCKET_${kind.toUpperCase()}.`)
  }
  return bucket
}

/**
 * The S3-compatible URL for one object.
 *
 * This is the *origin* address, used for signing. It is not what a feed video
 * is served from — that is the custom domain in `VITE_R2_PUBLIC_BASE`, which
 * the browser builds and this file never sees.
 */
export function objectUrl(config: R2Config, kind: BucketKind, key: string): string {
  const bucket = requireBucket(config, kind)
  // Encoded per segment so a key can hold anything the validator allows without
  // the path being reinterpreted. `aws4fetch` re-encodes for the canonical
  // request itself; this is about producing a URL that resolves.
  const path = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `https://${config.accountId}.r2.cloudflarestorage.com/${bucket}/${path}`
}

function signerFor(
  config: R2Config,
  options: {
    method: string
    url: string
    headers?: Record<string, string>
    signQuery?: boolean
    expiresIn?: number
    /** Test seam: pin the signing timestamp so a signature is reproducible. */
    datetime?: string
  },
): AwsV4Signer {
  const url = new URL(options.url)
  if (options.signQuery && options.expiresIn !== undefined) {
    url.searchParams.set('X-Amz-Expires', String(options.expiresIn))
  }

  return new AwsV4Signer({
    method: options.method,
    url: url.toString(),
    headers: options.headers,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: SERVICE,
    region: REGION,
    signQuery: options.signQuery,
    datetime: options.datetime,
    // `content-type` is on aws4fetch's unsignable list by default, and we want
    // it signed — see presignPut.
    allHeaders: options.headers !== undefined,
  })
}

export interface PresignPutOptions {
  /**
   * Pinned into the signature, so the browser must send exactly this. That is
   * the point rather than a side effect: an upload URL whose content type were
   * free would let a signed-in caller park `text/html` on the CDN domain, and
   * hosting somebody's page under our own name is not a thing to leave open.
   * The uploader builds its Blob with this exact type.
   */
  contentType: string
  expiresIn?: number
  datetime?: string
}

/** A URL the browser may PUT one object to, and nothing else. */
export async function presignPut(
  config: R2Config,
  kind: BucketKind,
  key: string,
  options: PresignPutOptions,
): Promise<string> {
  const signer = signerFor(config, {
    method: 'PUT',
    url: objectUrl(config, kind, key),
    headers: { 'content-type': options.contentType },
    signQuery: true,
    expiresIn: options.expiresIn ?? UPLOAD_EXPIRY_SECONDS,
    datetime: options.datetime,
  })

  const signed = await signer.sign()
  return signed.url.toString()
}

/** A URL the browser may GET one object from, until it expires. */
export async function presignGet(
  config: R2Config,
  kind: BucketKind,
  key: string,
  options: { expiresIn?: number; datetime?: string } = {},
): Promise<string> {
  const signer = signerFor(config, {
    method: 'GET',
    url: objectUrl(config, kind, key),
    signQuery: true,
    expiresIn: options.expiresIn ?? DOWNLOAD_EXPIRY_SECONDS,
    datetime: options.datetime,
  })

  const signed = await signer.sign()
  return signed.url.toString()
}

function client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: SERVICE,
    region: REGION,
  })
}

/**
 * Every key under a prefix.
 *
 * The backstop rather than the usual path: a publication records the exact keys
 * it wrote, so teardown is normally a known-length batch and never needs to ask.
 * This exists for the records that predate that field, and for reconciling what
 * is in the bucket against what the feed still references.
 */
export async function listPrefix(
  config: R2Config,
  kind: BucketKind,
  prefix: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const bucket = requireBucket(config, kind)
  const aws = client(config)
  const keys: string[] = []
  let token: string | undefined

  // Paged, because a prefix with more than a thousand objects is not an error —
  // it is a long video — and a silent first page would read as a successful
  // delete that left most of the files behind.
  do {
    const url = new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${bucket}`)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    if (token) url.searchParams.set('continuation-token', token)

    const signed = await aws.sign(url.toString(), { method: 'GET' })
    const response = await fetchImpl(signed)
    if (!response.ok) {
      throw new Error(`R2 refused a listing of "${prefix}" (${response.status}).`)
    }

    const xml = await response.text()
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      const key = match[1]
      if (key) keys.push(decodeXmlText(key))
    }

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)
    token = truncated && next?.[1] ? decodeXmlText(next[1]) : undefined
  } while (token)

  return keys
}

/** The five entities an S3 listing can put in a key, undone. */
function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export interface DeleteOutcome {
  deleted: string[]
  /** Keys the store would not remove, with why. Reported rather than thrown. */
  failed: { key: string; reason: string }[]
}

/**
 * Removes objects, a few at a time.
 *
 * One request per key rather than the batch DeleteObjects call, which wants an
 * XML body and a Content-MD5 that neither this runtime nor R2 agree about
 * cleanly. A publication is tens of objects, not thousands, and bounded
 * concurrency keeps that inside the function's ten-second budget with room to
 * spare.
 *
 * A missing object is a success, not a failure: S3 deletes are idempotent, and
 * the case that actually happens is a retry after a half-finished teardown.
 */
export async function deleteKeys(
  config: R2Config,
  kind: BucketKind,
  keys: string[],
  fetchImpl: typeof fetch = fetch,
  concurrency = 16,
): Promise<DeleteOutcome> {
  const aws = client(config)
  const deleted: string[] = []
  const failed: { key: string; reason: string }[] = []

  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++]
      if (key === undefined) continue

      try {
        const signed = await aws.sign(objectUrl(config, kind, key), { method: 'DELETE' })
        const response = await fetchImpl(signed)
        // 204 is the success; 404 means somebody got there first, which is the
        // same end state and must not read as a failure.
        if (response.ok || response.status === 404) {
          deleted.push(key)
        } else {
          failed.push({ key, reason: `R2 answered ${response.status}` })
        }
      } catch (error) {
        failed.push({ key, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  })

  await Promise.all(workers)
  return { deleted, failed }
}
