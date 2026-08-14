/**
 * Putting files into R2 from the browser.
 *
 * The bytes never touch our own server. `/api/r2/uploads` signs a URL per
 * object and the browser PUTs straight to Cloudflare, which is what keeps a
 * sixty-megabyte export clear of the six-megabyte function payload ceiling that
 * every other endpoint in this app is shaped by. It is also why an upload here
 * is a fan-out of ordinary `fetch` calls rather than one request.
 *
 * Two things the endpoint decides and this file must not:
 *
 *  - **The key.** We send bare names — `seg00001.m4s` — and get back full keys
 *    under a prefix derived from a verified token. Nothing here builds a path.
 *  - **The content type.** It is pinned into each signature, so the PUT has to
 *    send exactly the string that was signed or R2 answers an opaque
 *    `SignatureDoesNotMatch`. `fetch` derives that header from `blob.type` when
 *    the body is a Blob, so the Blob is rebuilt with the signed type rather
 *    than trusted to already carry it.
 */
import { mapLimited } from '../concurrency'
import { auth0Token } from '../auth0/client'
import { isMockEnabled } from '../mock'

/** One file to upload: a bare name, its bytes, and what it is. */
export interface UploadFile {
  name: string
  blob: Blob
  contentType: string
}

export interface UploadedObject {
  name: string
  /** The full R2 key, as the endpoint derived it. */
  key: string
}

export interface UploadResult {
  /** The prefix everything landed under, for teardown later. */
  prefix: string
  objects: UploadedObject[]
}

export type UploadScope = 'publication' | 'asset'

export interface UploadRequest {
  scope: UploadScope
  files: UploadFile[]
  /** Required for `publication`; names the folder within the account. */
  publicationId?: string
  /** The caller's Mintspace access token. Required for `publication`. */
  mintspaceToken?: string | null
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/**
 * Several at a time rather than all at once.
 *
 * The same reasoning as the Drive fan-out and hydration next door: starting
 * every segment of a long video together starves them all of bandwidth, and a
 * hundred concurrent PUTs is a good way to be rate limited by a service that
 * would happily have taken them in sequence.
 */
const UPLOAD_CONCURRENCY = 6

async function headers(request: UploadRequest): Promise<Record<string, string>> {
  const token = await auth0Token()
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    // A second identity, in a header of its own. Publishing decides *whose*
    // prefix the files go under, and that is the Mintspace account rather than
    // the Auth0 one — see netlify/lib/mintspaceToken.ts for why the two must
    // not be substituted for each other.
    ...(request.mintspaceToken
      ? { 'x-mintspace-authorization': `Bearer ${request.mintspaceToken}` }
      : {}),
  }
}

/**
 * This deployment has no storage behind it at all.
 *
 * Distinct from a failed upload, and the distinction matters to the caller: a
 * 503 from `/api/r2` is the endpoint reporting that *its own* environment is
 * incomplete, not that these bytes were refused. Every later attempt gets the
 * same answer, so retrying is waste and telling somebody their work is "not
 * backed up" is misleading — nothing on this deployment was ever going to back
 * it up, and there is nothing they can do about it from a browser.
 *
 * Whether R2 is configured is a fact about the server, which is why this is
 * discovered by asking rather than guessed at from a build-time variable.
 */
export class StorageUnconfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageUnconfiguredError'
  }
}

async function errorFrom(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string }
    if (body.error) {
      return new Error(body.detail ? `${body.error} ${body.detail}` : body.error)
    }
  } catch {
    /* fall through to the status */
  }
  return new Error(`${fallback} (${response.status})`)
}

/**
 * Signs, uploads, and reports where everything landed.
 *
 * The order of `files` is the order they are *finished* in, and it matters for
 * a publication: the playlist must be last, so that a playlist which exists
 * implies its segments exist. See `HlsPackage`. Concurrency is therefore
 * applied to everything but the final file, which is uploaded on its own after
 * the rest have settled.
 */
export async function uploadFiles(request: UploadRequest): Promise<UploadResult> {
  const { files, onProgress, signal } = request

  if (files.length === 0) throw new Error('There was nothing to upload.')

  if (isMockEnabled()) return mockUpload(request)

  const signResponse = await fetch('/api/r2/uploads', {
    method: 'POST',
    headers: await headers(request),
    signal,
    body: JSON.stringify({
      scope: request.scope,
      ...(request.publicationId ? { publicationId: request.publicationId } : {}),
      items: files.map((file) => ({
        name: file.name,
        contentType: file.contentType,
        bytes: file.blob.size,
      })),
    }),
  })

  if (!signResponse.ok) {
    const error = await errorFrom(signResponse, 'Could not prepare the upload')
    // The endpoint answers 503 with the names of the variables it is missing.
    // See StorageUnconfiguredError for why that is not the same as a failure.
    if (signResponse.status === 503) throw new StorageUnconfiguredError(error.message)
    throw error
  }

  const signed = (await signResponse.json()) as {
    prefix: string
    urls: { name: string; key: string; url: string }[]
  }

  const urlFor = new Map(signed.urls.map((entry) => [entry.name, entry]))
  let done = 0
  const total = files.length

  const put = async (file: UploadFile) => {
    const target = urlFor.get(file.name)
    if (!target) throw new Error(`The upload was not signed for "${file.name}".`)

    // Rebuilt with the signed type rather than sent as-is: `fetch` takes the
    // content-type header from `blob.type`, and a mismatch with what was signed
    // fails as SignatureDoesNotMatch, which says nothing about why.
    const body = new Blob([file.blob], { type: file.contentType })

    const response = await fetch(target.url, {
      method: 'PUT',
      headers: { 'content-type': file.contentType },
      body,
      signal,
    })
    if (!response.ok) {
      throw new Error(`R2 refused "${file.name}" (${response.status}).`)
    }

    done += 1
    onProgress?.(done, total)
    return { name: file.name, key: target.key }
  }

  // Everything but the last, then the last on its own. For an HLS package that
  // last file is the playlist, and publishing it before its segments would put
  // a card in the feed that spins forever.
  const leading = files.slice(0, -1)
  const final = files[files.length - 1] as UploadFile

  const objects = await mapLimited(leading, UPLOAD_CONCURRENCY, (file) => put(file))
  objects.push(await put(final))

  return { prefix: signed.prefix, objects }
}

/**
 * Mock mode: pretend, and hand back plausible keys.
 *
 * The end-to-end test drives the whole product with no credentials of any kind,
 * and publishing is part of the whole product. Without this the smoke test
 * would have to stop one step short of the thing most likely to break.
 */
function mockUpload(request: UploadRequest): UploadResult {
  const prefix =
    request.scope === 'publication'
      ? `v1/mock-account/${request.publicationId ?? 'mock'}/`
      : 'asset/mock-account/'

  request.onProgress?.(request.files.length, request.files.length)
  return {
    prefix,
    objects: request.files.map((file) => ({ name: file.name, key: `${prefix}${file.name}` })),
  }
}

/** Removes everything a publication wrote. */
export async function deletePublication(options: {
  publicationId: string
  keys: string[]
  mintspaceToken?: string | null
  signal?: AbortSignal
}): Promise<{ deleted: number; failed: { key: string; reason: string }[] }> {
  if (isMockEnabled()) return { deleted: options.keys.length, failed: [] }

  const response = await fetch('/api/r2/deletes', {
    method: 'POST',
    headers: await headers({
      scope: 'publication',
      files: [],
      mintspaceToken: options.mintspaceToken ?? null,
    }),
    signal: options.signal,
    body: JSON.stringify({
      scope: 'publication',
      publicationId: options.publicationId,
      keys: options.keys,
    }),
  })

  if (!response.ok) throw await errorFrom(response, 'Could not remove the files')
  return (await response.json()) as { deleted: number; failed: { key: string; reason: string }[] }
}
