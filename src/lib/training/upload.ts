/**
 * Sending a few hundred photos to the training bucket.
 *
 * A second uploader beside lib/r2/upload.ts rather than a flag on it, because
 * the two are shaped by opposite problems. That one sends a handful of files
 * that are one thing — the segments of a video — so it signs them in a single
 * request, fails the lot if any of them fails, and cares which order they
 * finish in. This sends four hundred files that are unrelated to each other,
 * over a quarter of an hour, on a connection that will drop at least once:
 * every file has to succeed, fail and be retried on its own, one refusal must
 * not throw away the three hundred that worked, and the whole thing must be
 * resumable. Folding both into one function would have meant a parameter
 * deciding which of those two things it was.
 *
 * They still meet at the endpoint: `/api/r2/uploads` signs, and the browser PUTs
 * straight to R2, so no photo passes through a function.
 */
import { auth0Token } from '../auth0/client'
import { isMockEnabled } from '../mock'
import { StorageUnconfiguredError } from '../r2/upload'
import type { NamedFile } from './names'

/**
 * How many files one signing request covers.
 *
 * The endpoint takes up to 512, so four hundred photos would fit in one — but
 * every URL in that response expires fifteen minutes after it is minted, and
 * four hundred photos do not upload in fifteen minutes on a domestic connection.
 * Signing a batch just before it is sent is what keeps the last file's URL as
 * fresh as the first's.
 */
const SIGN_BATCH = 25

/**
 * PUTs in flight at once.
 *
 * The same six as the publication uploader, and for the same reason: more than
 * this and they starve each other of bandwidth, which makes every individual
 * upload slower without making the set finish sooner.
 */
const UPLOAD_CONCURRENCY = 6

/** Per file, not per set. A dropped connection must not cost the whole run. */
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [1000, 4000]

export type ItemState = 'queued' | 'uploading' | 'done' | 'skipped' | 'failed'

export interface ItemProgress {
  name: string
  state: ItemState
  /** Set on `failed`, and on a `uploading` retry so the reason stays visible. */
  error?: string
  /** The full R2 key, once it has one. */
  key?: string
}

export interface UploadSetRequest<T extends Blob> {
  setId: string
  files: NamedFile<T>[]
  /** Names the bucket already holds. Anything in here is skipped, not sent. */
  already?: Set<string>
  onItem?: (progress: ItemProgress) => void
  signal?: AbortSignal
}

export interface UploadSetResult {
  uploaded: number
  skipped: number
  failed: { name: string; error: string }[]
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function headers(): Promise<Record<string, string>> {
  const token = await auth0Token()
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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
 * The endpoint said no, and will say no again.
 *
 * A 400 names something about the request itself — a name it will not store, a
 * set id it will not accept — and a 401 or 403 is an answer about the session.
 * Neither changes by asking a second time, which is what separates them from
 * the 500s and the timeouts that retrying exists for.
 */
export class RequestRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestRefusedError'
  }
}

/** Turns a non-OK response from `/api/r2` into the right kind of error. */
async function refusal(response: Response, fallback: string): Promise<Error> {
  const error = await errorFrom(response, fallback)
  // 503 is the endpoint saying its own environment has no training bucket. Every
  // later attempt gets the same answer, so this must not be retried and must not
  // be reported as these photos having been refused.
  if (response.status === 503) return new StorageUnconfiguredError(error.message)
  // 429 is the exception among the 4xx: it is explicitly "again, later".
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return new RequestRefusedError(error.message)
  }
  return error
}

/**
 * What this set already holds.
 *
 * Empty rather than an error when storage is unconfigured or the set has never
 * been written to — a set that does not exist yet holds nothing, which is the
 * same answer for the caller's purposes.
 */
export async function listTrainingSet(setId: string, signal?: AbortSignal): Promise<string[]> {
  if (isMockEnabled()) return []

  const response = await fetch('/api/r2/lists', {
    method: 'POST',
    headers: await headers(),
    signal,
    body: JSON.stringify({ scope: 'training', setId }),
  })

  if (!response.ok) throw await refusal(response, 'Could not read that set')

  const body = (await response.json()) as { names?: string[] }
  return body.names ?? []
}

interface SignedUrl {
  name: string
  key: string
  url: string
}

async function signBatch<T extends Blob>(
  setId: string,
  batch: NamedFile<T>[],
  signal?: AbortSignal,
): Promise<Map<string, SignedUrl>> {
  const response = await fetch('/api/r2/uploads', {
    method: 'POST',
    headers: await headers(),
    signal,
    body: JSON.stringify({
      scope: 'training',
      setId,
      items: batch.map((entry) => ({
        name: entry.name,
        contentType: entry.contentType,
        bytes: entry.file.size,
      })),
    }),
  })

  if (!response.ok) throw await refusal(response, 'Could not prepare the upload')

  const body = (await response.json()) as { urls: SignedUrl[] }
  return new Map(body.urls.map((entry) => [entry.name, entry]))
}

/**
 * Signing, with the same patience the PUTs get.
 *
 * A signing request that fails takes twenty-five photos with it, and over a
 * four-hundred-photo run there are sixteen of them — so the one request per
 * batch is exactly where a dropped connection is most expensive. A refusal is
 * not retried: a 400 names something about the batch that will still be true
 * next time, and a 503 is the deployment, not the moment.
 */
async function signBatchWithRetry<T extends Blob>(
  setId: string,
  batch: NamedFile<T>[],
  signal?: AbortSignal,
): Promise<Map<string, SignedUrl>> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await signBatch(setId, batch, signal)
    } catch (error) {
      if (
        isAbort(error) ||
        error instanceof StorageUnconfiguredError ||
        error instanceof RequestRefusedError
      ) {
        throw error
      }
      lastError = error
      if (attempt < MAX_ATTEMPTS) await wait(BACKOFF_MS[attempt - 1] ?? 4000, signal)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Uploads a whole set, reporting each file as it lands.
 *
 * Never rejects for a file that failed — those come back in `failed`, so a run
 * that lost eleven photos to a flaky connection still tells you the other three
 * hundred and eighty-nine are up and lets you retry the eleven. It does reject
 * for the two things that are about the whole run rather than one file: an
 * abort, and a deployment with no training bucket behind it.
 */
export async function uploadTrainingSet<T extends Blob>(
  request: UploadSetRequest<T>,
): Promise<UploadSetResult> {
  const { setId, files, already, onItem, signal } = request

  const result: UploadSetResult = { uploaded: 0, skipped: 0, failed: [] }
  const pending: NamedFile<T>[] = []

  for (const entry of files) {
    if (already?.has(entry.name)) {
      result.skipped += 1
      onItem?.({ name: entry.name, state: 'skipped' })
    } else {
      pending.push(entry)
    }
  }

  if (pending.length === 0) return result

  if (isMockEnabled()) {
    for (const entry of pending) {
      result.uploaded += 1
      onItem?.({ name: entry.name, state: 'done', key: `set/mock/${setId}/${entry.name}` })
    }
    return result
  }

  for (let start = 0; start < pending.length; start += SIGN_BATCH) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const batch = pending.slice(start, start + SIGN_BATCH)
    const signed = await signBatchWithRetry(setId, batch, signal)

    // Bounded concurrency written out rather than `mapLimited`, because each
    // worker has to keep going after a file fails: `mapLimited` propagates the
    // first rejection, which here would abandon the rest of the batch over one
    // photo the connection dropped.
    let next = 0
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, batch.length) }, async () => {
      while (next < batch.length) {
        const entry = batch[next++]
        if (!entry) continue
        await sendOne(entry, signed.get(entry.name), result, onItem, signal)
      }
    })

    await Promise.all(workers)
  }

  return result
}

async function sendOne<T extends Blob>(
  entry: NamedFile<T>,
  target: SignedUrl | undefined,
  result: UploadSetResult,
  onItem: UploadSetRequest<T>['onItem'],
  signal?: AbortSignal,
): Promise<void> {
  if (!target) {
    result.failed.push({ name: entry.name, error: 'The upload was not signed for this file.' })
    onItem?.({ name: entry.name, state: 'failed', error: 'The upload was not signed for it.' })
    return
  }

  let lastError = 'It did not upload.'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    onItem?.({
      name: entry.name,
      state: 'uploading',
      ...(attempt > 1 ? { error: lastError } : {}),
    })

    try {
      // Rebuilt with the signed type rather than sent as-is: `fetch` takes the
      // content-type header from `blob.type`, and a mismatch with what was
      // signed fails as SignatureDoesNotMatch, which says nothing about why.
      // Photos reach this page with an empty or guessed type often enough that
      // the two would otherwise disagree routinely — see contentTypeOf.
      const body = new Blob([entry.file], { type: entry.contentType })

      const response = await fetch(target.url, {
        method: 'PUT',
        headers: { 'content-type': entry.contentType },
        body,
        signal,
      })

      if (response.ok) {
        result.uploaded += 1
        onItem?.({ name: entry.name, state: 'done', key: target.key })
        return
      }

      lastError = `R2 answered ${response.status}.`
      // 4xx from R2 is a refusal — an expired signature, a type that does not
      // match — and sending the same bytes to the same URL again will be
      // refused the same way. Only a server-side wobble is worth another go.
      if (response.status < 500 && response.status !== 429) break
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < MAX_ATTEMPTS) await wait(BACKOFF_MS[attempt - 1] ?? 4000, signal)
  }

  result.failed.push({ name: entry.name, error: lastError })
  onItem?.({ name: entry.name, state: 'failed', error: lastError })
}
